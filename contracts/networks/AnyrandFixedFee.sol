// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.23;

import {Anyrand} from "../Anyrand.sol";

/// @title AnyrandFixedFee
/// @notice Anyrand with fixed fee regardless of gas price
contract AnyrandFixedFee is Anyrand {
    constructor(
        uint256[4] memory publicKey_,
        uint256 genesisTimestamp_,
        uint256 period_,
        uint256 initialRequestPrice,
        uint256 maxCallbackGasLimit_,
        uint256 maxDeadlineDelta_
    )
        Anyrand(
            publicKey_,
            genesisTimestamp_,
            period_,
            initialRequestPrice,
            maxCallbackGasLimit_,
            maxDeadlineDelta_
        )
    {}

    /// @notice Always return the base request price
    function getRequestPrice(
        uint256
    ) public view virtual override returns (uint256) {
        return baseRequestPrice;
    }
}
