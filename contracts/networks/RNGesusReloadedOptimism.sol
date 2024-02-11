// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.23;

import {RNGesusReloaded} from "../RNGesusReloaded.sol";
// We use a Scroll contract for Optimism because:
//  - OP repo is not usable with hardhat
//  - OP devs didn't bother to create an interface for GasPriceOracle
//  - Scroll devs actually bothered to create an interface
//  - Scroll's GasPriceOracle follows the same interface
import {IL1GasPriceOracle} from "@scroll-tech/contracts/L2/predeploys/IL1GasPriceOracle.sol";

/// @title RNGesusReloaded for OP Bedrock
contract RNGesusReloadedOptimism is RNGesusReloaded {
    /// @notice Gas cost of zero byte calldata on L1
    uint256 public constant TX_DATA_ZERO_GAS = 4;
    /// @notice Gas cost of non-zero byte calldata on L1
    uint256 public constant TX_DATA_NON_ZERO_GAS = 16;
    /// @notice Decimal precision of L1_GAS_PRICE_ORACLE
    uint256 public constant PRECISION = 1e9;

    /// @notice Actual avg: ~103B
    uint256 public constant FULFILL_RANDOMNESS_TX_ZERO_BYTES = 150;
    /// @notice Actual avg: ~194B
    uint256 public constant FULFILL_RANDOMNESS_TX_NON_ZERO_BYTES = 250;

    /// @notice mmm chocolate so good yes yes yes
    uint256 public constant FUDGE_FACTOR_BPS = 15000;

    /// @notice Optimism L2 system contract
    address public constant L1_GAS_PRICE_ORACLE =
        0x420000000000000000000000000000000000000F;

    constructor(
        uint256[4] memory publicKey_,
        uint256 genesisTimestamp_,
        uint256 period_,
        uint256 initialRequestPrice,
        uint256 maxCallbackGasLimit_,
        uint256 maxDeadlineDelta_
    )
        RNGesusReloaded(
            publicKey_,
            genesisTimestamp_,
            period_,
            initialRequestPrice,
            maxCallbackGasLimit_,
            maxDeadlineDelta_
        )
    {}

    /// @notice Compute the total request price
    function getRequestPrice(
        uint256 callbackGasLimit
    ) public view virtual override returns (uint256) {
        // Compute L1 calldata fee estimate
        // See: https://docs.scroll.io/en/developers/transaction-fees-on-scroll/
        uint256 overhead = IL1GasPriceOracle(L1_GAS_PRICE_ORACLE).overhead();
        uint256 l1BaseFee = IL1GasPriceOracle(L1_GAS_PRICE_ORACLE).l1BaseFee();
        uint256 scalar = IL1GasPriceOracle(L1_GAS_PRICE_ORACLE).scalar();
        uint256 l1Gas = FULFILL_RANDOMNESS_TX_ZERO_BYTES *
            TX_DATA_ZERO_GAS +
            (FULFILL_RANDOMNESS_TX_NON_ZERO_BYTES + 4) *
            TX_DATA_NON_ZERO_GAS;
        uint256 l1GasFee = ((l1Gas + overhead) * l1BaseFee * scalar) /
            PRECISION;
        // Compute L2 execution fee estimate
        uint256 l2GasFee = (200_000 + callbackGasLimit) * tx.gasprice;
        // Sprinkle in some fudge in case of volatility
        uint256 totalGasFee = ((l2GasFee + l1GasFee) * FUDGE_FACTOR_BPS) /
            10000;
        return baseRequestPrice + totalGasFee;
    }
}
