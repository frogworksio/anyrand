// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import {BLS} from "@kevincharm/bls-bn254/contracts/BLS.sol";
import {IDrandBeacon} from "../interfaces/IDrandBeacon.sol";

/// @title DrandBeacon
/// @author Kevin Charm <kevin@frogworks.io>
/// @notice Contract containing immutable information about a drand beacon.
contract DrandBeacon is IDrandBeacon {
    /// @notice Group PK Re(x) in G2
    uint256 public immutable publicKey0;
    /// @notice Group PK Im(x) in G2
    uint256 public immutable publicKey1;
    /// @notice Group PK Re(y) in G2
    uint256 public immutable publicKey2;
    /// @notice Group PK Im(y) in G2
    uint256 public immutable publicKey3;
    /// @notice The beacon's period, in seconds
    uint256 public immutable period;
    /// @notice Genesis timestamp
    uint256 public immutable genesisTimestamp;

    error InvalidPublicKey(uint256[4] pubKey);
    error InvalidBeaconConfiguration(uint256 genesisTimestamp, uint256 period);

    constructor(
        uint256[4] memory publicKey_,
        uint256 genesisTimestamp_,
        uint256 period_
    ) {
        if (!BLS.isValidPublicKey(publicKey_)) {
            revert InvalidPublicKey(publicKey_);
        }
        publicKey0 = publicKey_[0];
        publicKey1 = publicKey_[1];
        publicKey2 = publicKey_[2];
        publicKey3 = publicKey_[3];

        if (genesisTimestamp_ == 0 || period_ == 0) {
            revert InvalidBeaconConfiguration(genesisTimestamp_, period_);
        }
        genesisTimestamp = genesisTimestamp_;
        period = period_;
    }

    function getPublicKey() public view returns (bytes memory) {
        return abi.encodePacked(publicKey0, publicKey1, publicKey2, publicKey3);
    }

    function getPublicKeyHash() public view returns (bytes32) {
        return keccak256(getPublicKey());
    }
}
