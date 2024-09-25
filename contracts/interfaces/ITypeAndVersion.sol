// SPDX-License-Identifier: MIT
pragma solidity ^0.8;

/// @title ITypeAndVersion
interface ITypeAndVersion {
    /// @notice Identifier for contract type and version
    function typeAndVersion() external view returns (string memory);
}
