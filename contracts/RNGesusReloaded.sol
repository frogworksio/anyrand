// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.23;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {BLS} from "./bls/BLS.sol";

contract RNGesusReloaded is Ownable {
    struct DrandBeacon {
        uint256[4] publicKey;
        uint256 genesisTimestamp;
    }

    mapping(bytes32 pubKeyHash => DrandBeacon) public beacons;

    constructor() Ownable(msg.sender) {}

    function getPubKeyHash(
        uint256[4] memory publicKey
    ) public pure returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    publicKey[0],
                    publicKey[1],
                    publicKey[2],
                    publicKey[3]
                )
            );
    }

    function registerBeacon(DrandBeacon calldata drandBeacon) external {
        bytes32 pubKeyHash = getPubKeyHash(drandBeacon.publicKey);
        beacons[pubKeyHash] = drandBeacon;
    }
}
