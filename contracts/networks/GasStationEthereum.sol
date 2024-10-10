// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {IGasStation} from "../interfaces/IGasStation.sol";

/// @title GasStationEthereum
contract GasStationEthereum is IGasStation {
    /// @notice See {ITypeAndVersion-typeAndVersion}
    function typeAndVersion() external pure returns (string memory) {
        return "GasStationEthereum 1.0.0";
    }

    /// @notice Compute the total request price
    function getTxCost(
        uint256 gasLimit
    ) public view virtual override returns (uint256, uint256) {
        uint256 totalGasFee = gasLimit * tx.gasprice;
        return (totalGasFee, totalGasFee / gasLimit);
    }
}
