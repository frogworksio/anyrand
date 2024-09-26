// SPDX-License-Identifier: MIT
pragma solidity ^0.8;

/// @title IDrandBeacon
/// @author Kevin Charm (kevin@frogworks.io)
/// @notice Contract containing immutable information about a drand beacon.
interface IDrandBeacon {
    /// @notice Get the period of the beacon
    function period() external view returns (uint256);

    /// @notice Get the genesis timestamp of the beacon
    function genesisTimestamp() external view returns (uint256);

    /// @notice Get the public key of the beacon
    function getPublicKey() external view returns (bytes memory);

    /// @notice Get the public key hash of the beacon
    function getPublicKeyHash() external view returns (bytes32);
}
