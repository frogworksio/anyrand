// SPDX-License-Identifier: MIT
pragma solidity ^0.8;

interface IRandomiserCallbackV3 {
    /// @notice Receive random words from a randomiser.
    /// @dev Ensure that proper access control is enforced on this function;
    ///     only the designated randomiser may call this function and the
    ///     requestId should be as expected from the randomness request.
    /// @param requestId The identifier for the original randomness request
    /// @param randomWord Uniform random number in the range [0, 2**256)
    function receiveRandomness(uint256 requestId, uint256 randomWord) external;
}
