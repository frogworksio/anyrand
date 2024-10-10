// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IGasStation} from "../interfaces/IGasStation.sol";
import {IGasPriceOracle} from "../interfaces/optimism/IGasPriceOracle.sol";

/// @title GasStationOptimism
/// @author Kevin Charm <kevin@frogworks.io>
/// @notice Gas cost estimator for submitting a fulfillRandomness transaction
///     on Optimism "Fjord"
contract GasStationOptimism is IGasStation {
    /// @notice Non-zero dummy bytes to simulate a worst-case serialised RLP-
    ///     encoded unsigned transaction. In reality, this is some tx params
    ///     such as nonce, gas price, value, etc followed by the calldata.
    bytes constant RLP_DUMMY_BYTES =
        hex"ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";

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
    ) public view virtual override returns (uint256, uint256) {
        uint256 l1GasFee = IGasPriceOracle(L1_GAS_PRICE_ORACLE).getL1Fee(
            RLP_DUMMY_BYTES
        );
        uint256 l2GasFee = gasLimit * tx.gasprice;
        uint256 totalGasFee = l2GasFee + l1GasFee;
        uint256 effectiveFeePerGas = totalGasFee / gasLimit;
        return (totalGasFee, effectiveFeePerGas);
    }
}
