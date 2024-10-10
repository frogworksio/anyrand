// SPDX-License-Identifier: MIT
pragma solidity ^0.8;

import {IDrandBeacon} from "../interfaces/IDrandBeacon.sol";

contract AlwaysVerifiesBeacon is IDrandBeacon {
    bytes private _pubKey;
    uint256 private immutable _genesisTimestamp;
    uint256 private immutable _period;

    constructor(
        bytes memory pubKey_,
        uint256 genesisTimestamp_,
        uint256 period_
    ) {
        _pubKey = pubKey_;
        _genesisTimestamp = genesisTimestamp_;
        _period = period_;
    }

    /// @notice Get the public key of the beacon
    function publicKey() external view returns (bytes memory) {
        return _pubKey;
    }

    /// @notice Get the public key hash of the beacon
    function publicKeyHash() external view returns (bytes32) {
        return keccak256(_pubKey);
    }

    /// @notice Get the genesis timestamp of the beacon
    function genesisTimestamp() external view returns (uint256) {
        return _genesisTimestamp;
    }

    /// @notice Get the period of the beacon
    function period() external view returns (uint256) {
        return _period;
    }

    function verifyBeaconRound(uint256, uint256[2] calldata) external pure {
        revert("Not implemented");
    }
}
