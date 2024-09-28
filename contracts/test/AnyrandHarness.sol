// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import {Anyrand} from "../Anyrand.sol";

contract AnyrandHarness is Anyrand {
    function hashRequest(
        uint256 requestId,
        address requester,
        bytes32 publicKeyHash,
        uint256 round,
        uint256 callbackGasLimit
    ) public view returns (bytes32) {
        return
            _hashRequest(
                requestId,
                requester,
                publicKeyHash,
                round,
                callbackGasLimit
            );
    }

    function verifyBeaconRound(
        uint256 round,
        uint256[2] calldata signature
    ) public view {
        _verifyBeaconRound(round, signature);
    }

    function setRequest(
        uint256 requestId,
        address requester,
        bytes32 publicKeyHash,
        uint256 round,
        uint256 callbackGasLimit
    ) public {
        MainStorage storage $ = _getMainStorage();
        $.requests[requestId] = _hashRequest(
            requestId,
            requester,
            publicKeyHash,
            round,
            callbackGasLimit
        );
    }
}
