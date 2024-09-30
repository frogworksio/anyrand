// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.23;

import {IRandomiserCallback} from "../interfaces/IRandomiserCallback.sol";
import {Anyrand} from "../Anyrand.sol";

/// @title ReentrantFulfiler
contract ReentrantFulfiler is IRandomiserCallback {
    /// @notice Anyrand instance
    address public immutable anyrand;
    /// @notice Recorded randomness. A special value of 1 means the request is
    ///     inflight
    mapping(uint256 requestId => uint256) public randomness;

    event RandomnessReceived(uint256 randomness);

    constructor(address anyrand_) {
        anyrand = anyrand_;
    }

    receive() external payable {}

    /// @notice Request a random number, calling back to this contract
    function getRandom(uint256 deadline, uint256 callbackGasLimit) public {
        require(deadline > block.timestamp, "Deadline is in the past");
        (uint256 requestPrice, ) = Anyrand(anyrand).getRequestPrice(
            callbackGasLimit
        );
        uint256 requestId = Anyrand(anyrand).requestRandomness{
            value: requestPrice
        }(deadline, callbackGasLimit);
        randomness[requestId] = 1;
    }

    /// @notice Request a random number, calling back to this contract
    function fulfillRandomness(
        uint256 requestId,
        bytes32 pubKeyHash,
        uint256 round,
        uint256 callbackGasLimit,
        uint256[2] memory signature
    ) public {
        Anyrand(anyrand).fulfillRandomness(
            requestId,
            address(this),
            pubKeyHash,
            round,
            callbackGasLimit,
            signature
        );
    }

    /// @notice See {IRandomiserCallback-receiveRandomWords}
    function receiveRandomWords(
        uint256 requestId,
        uint256[] calldata randomWords
    ) external {
        require(msg.sender == anyrand, "Only callable by Anyrand");
        require(randomness[requestId] == 1, "Unknown requestId");
        randomness[requestId] = randomWords[0];
        // Try to reenter
        Anyrand(anyrand).fulfillRandomness(
            requestId,
            address(this),
            bytes32(0),
            1,
            500_000,
            [uint256(0), uint256(0)]
        );
    }
}
