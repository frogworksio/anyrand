// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8;

import {ITypeAndVersion} from "./ITypeAndVersion.sol";

interface IGasStation is ITypeAndVersion {
    /// @notice Compute the instantaneous cost of a transaction that consumes
    ///     `gasLimit` of gas
    /// @param gasLimit The gas limit that will be used to calculate the cost
    ///     of the transaction.
    /// @return The total transaction cost (in wei)
    function getTxCost(uint256 gasLimit) external view returns (uint256);
}
