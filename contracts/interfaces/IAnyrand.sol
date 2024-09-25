// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8;

import {ITypeAndVersion} from "./ITypeAndVersion.sol";

interface IAnyrand is ITypeAndVersion {
    event RandomnessRequested(
        uint256 indexed requestId,
        address requester,
        uint256 round,
        uint256 callbackGasLimit,
        uint256 feePaid
    );
    event RandomnessFulfilled(
        uint256 indexed requestId,
        uint256[] randomWords,
        bool callbackSuccess
    );
    event RandomnessCallbackFailed(uint256 indexed requestId, bytes32 retdata);
    event RequestPriceUpdated(uint256 newPrice);
    event ETHWithdrawn(uint256 amount);
    event MaxCallbackGasLimitUpdated(uint256 newMaxCallbackGasLimit);
    event MaxDeadlineDeltaUpdated(uint256 maxDeadlineDelta);
    event GasStationUpdated(address indexed newGasStation);

    error TransferFailed(address to, uint256 value);
    error IncorrectPayment(uint256 got, uint256 want);
    error OverGasLimit(uint256 callbackGasLimit);
    error InvalidRequestHash(bytes32 requestHash);
    error InvalidSignature(
        uint256[4] pubKey,
        uint256[2] message,
        uint256[2] signature
    );
    error InvalidPublicKey(uint256[4] pubKey);
    error InvalidBeaconConfiguration(uint256 genesisTimestamp, uint256 period);
    error InvalidDeadline(uint256 deadline);
    error InsufficientGas();
    error Reentrant();

    /// @notice Domain separation tag conforming to RFC9380
    function DST() external view returns (bytes memory);

    /// @notice Return this beacon's public key
    function getPubKey() external view returns (bytes memory);

    /// @notice Compute the total request price
    /// @param callbackGasLimit The callback gas limit that will be used for
    ///     the randomness request
    function getRequestPrice(
        uint256 callbackGasLimit
    ) external view returns (uint256);

    /// @notice Request randomness
    /// @param deadline Timestamp of when the randomness should be fulfilled. A
    ///     beacon round closest to this timestamp (rounding up to the nearest
    ///     future round) will be used as the round from which to derive
    ///     randomness.
    /// @param callbackGasLimit Gas limit for callback
    function requestRandomness(
        uint256 deadline,
        uint256 callbackGasLimit
    ) external payable returns (uint256);
}
