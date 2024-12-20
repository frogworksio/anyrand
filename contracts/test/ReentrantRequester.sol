// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IRandomiserCallbackV3} from "../interfaces/IRandomiserCallbackV3.sol";
import {Anyrand} from "../Anyrand.sol";

/// @title ReentrantRequester
contract ReentrantRequester is IRandomiserCallbackV3 {
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

    /// @notice See {IRandomiserCallbackV3-receiveRandomness}
    function receiveRandomness(uint256 requestId, uint256 randomWord) external {
        require(msg.sender == anyrand, "Only callable by Anyrand");
        require(randomness[requestId] == 1, "Unknown requestId");
        randomness[requestId] = randomWord;
        // Try to reenter
        Anyrand(anyrand).requestRandomness(block.timestamp + 100, 500_000);
    }
}
