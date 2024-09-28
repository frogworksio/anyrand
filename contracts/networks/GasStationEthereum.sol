// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.23;

import {IGasStation} from "../interfaces/IGasStation.sol";

/// @title GasStationEthereum
contract GasStationEthereum is IGasStation {
    /// @notice mmm chocolate so good yes yes yes
    uint256 public constant FUDGE_FACTOR_BPS = 15000;

    /// @notice See {ITypeAndVersion-typeAndVersion}
    function typeAndVersion() external pure returns (string memory) {
        return "GasStationEthereum 1.0.0";
    }

    /// @notice Compute the total request price
    function getTxCost(
        uint256 gasLimit
    ) public view virtual override returns (uint256) {
        uint256 rawTxFee = (200_000 + gasLimit) * tx.gasprice;
        // Sprinkle in some fudge in case of volatility
        uint256 totalGasFee = (rawTxFee * FUDGE_FACTOR_BPS) / 10000;
        return totalGasFee;
    }
}
