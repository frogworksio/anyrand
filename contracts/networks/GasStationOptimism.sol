// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.23;

import {IGasStation} from "../interfaces/IGasStation.sol";
import {IGasPriceOracle} from "../interfaces/optimism/IGasPriceOracle.sol";

/// @title GasStationOptimism
/// @notice Supports: Bedrock, Ecotone, Fjord
contract GasStationOptimism is IGasStation {
    /// @notice Gas cost of zero byte calldata on L1
    uint256 private constant TX_DATA_ZERO_GAS = 4;
    /// @notice Gas cost of non-zero byte calldata on L1
    uint256 private constant TX_DATA_NON_ZERO_GAS = 16;
    /// @notice Decimal precision of L1_GAS_PRICE_ORACLE
    uint256 private constant PRECISION = 1e9;

    /// @notice Actual avg: ~103B
    uint256 private constant FULFILL_RANDOMNESS_TX_ZERO_BYTES = 150;
    /// @notice Actual avg: ~194B
    uint256 private constant FULFILL_RANDOMNESS_TX_NON_ZERO_BYTES = 250;
    /// @notice Actual avg: ~153B
    uint256 private constant FULFILL_RANDOMNESS_TX_FLZ_COMPRESSED_BYTES = 200;
    /// @notice Total calldata gas
    /// https://github.com/ethereum-optimism/optimism/blob/52abfb507342191ae1f960b443ae8aec7598755c/packages/contracts-bedrock/src/L2/GasPriceOracle.sol#L210
    uint256 private constant FULFILL_RANDOMNESS_TX_TOTAL_CALLDATA_GAS =
        (FULFILL_RANDOMNESS_TX_ZERO_BYTES *
            TX_DATA_ZERO_GAS +
            FULFILL_RANDOMNESS_TX_NON_ZERO_BYTES *
            TX_DATA_NON_ZERO_GAS) + (68 * 16);

    /// @notice This is the intercept value for the linear regression used to
    ///     estimate the final size of the compressed transaction.
    int32 private constant COST_INTERCEPT = -42_585_600;
    /// @notice This is the coefficient value for the linear regression used to
    ///     estimate the final size of the compressed transaction.
    uint32 private constant COST_FASTLZ_COEF = 836_500;
    /// @notice This is the minimum bound for the fastlz to brotli size
    ///     estimation. Any estimations below this are set to this value.
    uint256 private constant MIN_TRANSACTION_SIZE = 100;

    /// @notice mmm chocolate so good yes yes yes
    uint256 private constant FUDGE_FACTOR_BPS = 15000;

    /// @notice Optimism L2 system contract
    address public constant L1_GAS_PRICE_ORACLE =
        0x420000000000000000000000000000000000000F;

    /// @notice See {ITypeAndVersion-typeAndVersion}
    function typeAndVersion() external pure override returns (string memory) {
        return "GasStationOptimism 1.0.0";
    }

    /// @notice Compute the total request price
    function getTxCost(
        uint256 gasLimit
    ) public view virtual override returns (uint256) {
        uint256 l1GasFee;
        if (IGasPriceOracle(L1_GAS_PRICE_ORACLE).isEcotone()) {
            l1GasFee = _getL1FeeEcotone();
        } else if (IGasPriceOracle(L1_GAS_PRICE_ORACLE).isFjord()) {
            l1GasFee = _getL1FeeFjord();
        } else {
            // Fallback to Bedrock calculation
            l1GasFee = _getL1FeeBedrock();
        }

        // Compute L2 execution fee estimate
        uint256 l2GasFee = (200_000 + gasLimit) * tx.gasprice;
        // Sprinkle in some fudge in case of volatility
        uint256 totalGasFee = ((l2GasFee + l1GasFee) * FUDGE_FACTOR_BPS) /
            10000;
        return totalGasFee;
    }

    /// @notice Computation of the L1 portion of the fee for Bedrock.
    /// @return L1 fee that should be paid for the tx
    function _getL1FeeBedrock() internal view returns (uint256) {
        IGasPriceOracle l1GasPriceOracle = IGasPriceOracle(L1_GAS_PRICE_ORACLE);
        uint256 fee = (FULFILL_RANDOMNESS_TX_TOTAL_CALLDATA_GAS +
            l1GasPriceOracle.overhead()) *
            l1GasPriceOracle.l1BaseFee() *
            l1GasPriceOracle.scalar();
        return fee / (10 ** l1GasPriceOracle.decimals());
    }

    /// @notice L1 portion of the fee after Ecotone.
    /// @return L1 fee that should be paid for the tx
    function _getL1FeeEcotone() internal view returns (uint256) {
        IGasPriceOracle l1GasPriceOracle = IGasPriceOracle(L1_GAS_PRICE_ORACLE);
        uint256 scaledBaseFee = l1GasPriceOracle.baseFeeScalar() *
            16 *
            l1GasPriceOracle.l1BaseFee();
        uint256 scaledBlobBaseFee = l1GasPriceOracle.blobBaseFeeScalar() *
            l1GasPriceOracle.blobBaseFee();
        uint256 fee = FULFILL_RANDOMNESS_TX_TOTAL_CALLDATA_GAS *
            (scaledBaseFee + scaledBlobBaseFee);
        return fee / (16 * 10 ** l1GasPriceOracle.decimals());
    }

    /// @notice L1 portion of the fee after Fjord.
    /// @return L1 fee that should be paid for the tx
    function _getL1FeeFjord() internal view returns (uint256) {
        return _fjordL1Cost(FULFILL_RANDOMNESS_TX_FLZ_COMPRESSED_BYTES);
    }

    /// @notice Fjord L1 cost based on the compressed and original tx size.
    /// @param _fastLzSize estimated compressed tx size.
    /// @return Fjord L1 fee that should be paid for the tx
    function _fjordL1Cost(uint256 _fastLzSize) internal view returns (uint256) {
        IGasPriceOracle l1GasPriceOracle = IGasPriceOracle(L1_GAS_PRICE_ORACLE);
        // Apply the linear regression to estimate the Brotli 10 size
        uint256 estimatedSize = _fjordLinearRegression(_fastLzSize);
        uint256 feeScaled = l1GasPriceOracle.baseFeeScalar() *
            16 *
            l1GasPriceOracle.l1BaseFee() +
            l1GasPriceOracle.blobBaseFeeScalar() *
            l1GasPriceOracle.blobBaseFee();
        return
            (estimatedSize * feeScaled) /
            (10 ** (l1GasPriceOracle.decimals() * 2));
    }

    /// @notice Takes the fastLz size compression and returns the estimated Brotli
    /// @param _fastLzSize fastlz compressed tx size.
    /// @return Number of bytes in the compressed transaction
    function _fjordLinearRegression(
        uint256 _fastLzSize
    ) internal pure returns (uint256) {
        int256 estimatedSize = COST_INTERCEPT +
            int256(COST_FASTLZ_COEF * _fastLzSize);
        if (estimatedSize < int256(MIN_TRANSACTION_SIZE) * 1e6) {
            estimatedSize = int256(MIN_TRANSACTION_SIZE) * 1e6;
        }
        return uint256(estimatedSize);
    }
}
