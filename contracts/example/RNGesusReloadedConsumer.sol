// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.23;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IRandomiserCallback} from "../interfaces/IRandomiserCallback.sol";
import {RNGesusReloaded} from "../RNGesusReloaded.sol";

/// @title RNGesusReloadedConsumer
contract RNGesusReloadedConsumer is Ownable, IRandomiserCallback {
    /// @notice RNGesus instance
    address public immutable rngesus;
    /// @notice Recorded randomness. A special value of 1 means the request is
    ///     inflight
    mapping(uint256 requestId => uint256) public randomness;

    event RandomnessReceived(uint256 randomness);

    constructor(address rngesus_) Ownable(msg.sender) {
        rngesus = rngesus_;
    }

    /// @notice Request a random number, calling back to this contract
    function getRandom(
        uint256 secondsToWait,
        uint256 callbackGasLimit
    ) external payable {
        uint256 requestId = RNGesusReloaded(rngesus).requestRandomness{
            value: msg.value
        }(block.timestamp + secondsToWait, callbackGasLimit);
        randomness[requestId] = 1;
    }

    /// @notice See {IRandomiserCallback-receiveRandomWords}
    function receiveRandomWords(
        uint256 requestId,
        uint256[] calldata randomWords
    ) external {
        require(msg.sender == rngesus, "Only callable by RNGesus");
        require(randomness[requestId] == 1, "Unknown requestId");
        randomness[requestId] = randomWords[0];
    }
}
