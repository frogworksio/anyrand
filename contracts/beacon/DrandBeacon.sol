// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import {BLS} from "@kevincharm/bls-bn254/contracts/BLS.sol";
import {SSTORE2} from "solady/src/utils/SSTORE2.sol";
import {IDrandBeacon} from "../interfaces/IDrandBeacon.sol";

/// @title DrandBeacon
/// @author Kevin Charm <kevin@frogworks.io>
/// @notice Contract containing immutable information about a drand beacon.
contract DrandBeacon is IDrandBeacon {
    /**
     * ---------------------+-------+
     * var                  |  size |
     * ---------------------+-------+
     * publicKey            |   128 |
     * genesisTimestamp     |    32 |
     * period               |    32 |
     * ---------------------+-------+
     */
    uint256 private constant PTR_PUBLIC_KEY = 0;
    uint256 private constant LEN_PUBLIC_KEY = 128;
    uint256 private constant PTR_GENESIS_TIMESTAMP = 128;
    uint256 private constant LEN_GENESIS_TIMESTAMP = 32;
    uint256 private constant PTR_PERIOD = 160;
    uint256 private constant LEN_PERIOD = 32;

    /// @notice Pointer to immutable data
    address public immutable data;

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
        bytes memory pubKey = abi.encodePacked(
            publicKey_[0],
            publicKey_[1],
            publicKey_[2],
            publicKey_[3]
        );

        if (genesisTimestamp_ == 0 || period_ == 0) {
            revert InvalidBeaconConfiguration(genesisTimestamp_, period_);
        }

        data = SSTORE2.write(
            abi.encodePacked(pubKey, genesisTimestamp_, period_)
        );

        // Sanity checks
        assert(keccak256(publicKey()) == keccak256(pubKey));
        assert(genesisTimestamp() == genesisTimestamp_);
        assert(period() == period_);
    }

    /// @notice Get the public key of the beacon
    function publicKey() public view returns (bytes memory) {
        return
            SSTORE2.read(data, PTR_PUBLIC_KEY, PTR_PUBLIC_KEY + LEN_PUBLIC_KEY);
    }

    /// @notice Get the public key hash of the beacon
    function publicKeyHash() public view returns (bytes32) {
        return keccak256(publicKey());
    }

    /// @notice Get the genesis timestamp of the beacon
    function genesisTimestamp() public view returns (uint256) {
        return
            abi.decode(
                SSTORE2.read(
                    data,
                    PTR_GENESIS_TIMESTAMP,
                    PTR_GENESIS_TIMESTAMP + LEN_GENESIS_TIMESTAMP
                ),
                (uint256)
            );
    }

    /// @notice Get the period of the beacon
    function period() public view returns (uint256) {
        return
            abi.decode(
                SSTORE2.read(data, PTR_PERIOD, PTR_PERIOD + LEN_PERIOD),
                (uint256)
            );
    }
}
