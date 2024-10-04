// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.23;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IRandomiserCallbackV3} from "../interfaces/IRandomiserCallbackV3.sol";
import {Anyrand} from "../Anyrand.sol";

/// @title RevertingCallback
contract RevertingCallback is Ownable, IRandomiserCallbackV3 {
    /// @notice Anyrand instance
    address public immutable anyrand;
    /// @notice Recorded randomness. A special value of 1 means the request is
    ///     inflight
    mapping(uint256 requestId => uint256) public randomness;

    event RandomnessReceived(uint256 randomness);
    error AlwaysBeErroring();

    constructor(address anyrand_) Ownable(msg.sender) {
        anyrand = anyrand_;
    }

    /// @notice Request a random number, calling back to this contract
    function getRandom(
        uint256 deadline,
        uint256 callbackGasLimit
    ) external payable {
        require(deadline > block.timestamp, "Deadline is in the past");
        (uint256 requestPrice, ) = Anyrand(anyrand).getRequestPrice(
            callbackGasLimit
        );
        require(msg.value >= requestPrice, "Insufficient payment");
        if (msg.value > requestPrice) {
            (bool success, ) = msg.sender.call{value: msg.value - requestPrice}(
                ""
            );
            require(success, "Refund failed");
        }
        uint256 requestId = Anyrand(anyrand).requestRandomness{
            value: requestPrice
        }(deadline, callbackGasLimit);
        randomness[requestId] = 1;
    }

    /// @notice See {IRandomiserCallbackV3-receiveRandomness}
    function receiveRandomness(uint256, uint256) external {
        revert AlwaysBeErroring();
    }
}
