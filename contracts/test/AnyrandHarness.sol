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

    function gas_getRequestPrice(
        uint256 callbackGasLimit
    )
        public
        view
        returns (
            uint256 gasCost,
            uint256 totalPrice,
            uint256 effectiveFeePerGas
        )
    {
        gasCost = gasleft();
        (totalPrice, effectiveFeePerGas) = getRequestPrice(callbackGasLimit);
        gasCost = gasCost - gasleft();
    }
}
