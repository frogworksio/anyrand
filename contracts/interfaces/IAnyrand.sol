// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8;

import {ITypeAndVersion} from "./ITypeAndVersion.sol";

interface IAnyrand is ITypeAndVersion {
    event RandomnessRequested(
        uint256 indexed requestId,
        address indexed requester,
        bytes32 indexed pubKeyHash,
        uint256 round,
        uint256 callbackGasLimit,
        uint256 feePaid,
        uint256 effectiveFeePerGas
    );
    event RandomnessFulfilled(
        uint256 indexed requestId,
        uint256[] randomWords,
        bool callbackSuccess
    );
    event RandomnessCallbackFailed(uint256 indexed requestId, bytes32 retdata);
    event RequestPremiumMultiplierUpdated(uint256 newPrice);
    event ETHWithdrawn(uint256 amount);
    event BeaconUpdated(address indexed newBeacon);
    event MaxCallbackGasLimitUpdated(uint256 newMaxCallbackGasLimit);
    event MaxDeadlineDeltaUpdated(uint256 maxDeadlineDelta);
    event GasStationUpdated(address indexed newGasStation);
    event MaxFeePerGasUpdated(uint256 maxFeePerGas);

    error TransferFailed(address to, uint256 value);
    error IncorrectPayment(uint256 got, uint256 want);
    error OverGasLimit(uint256 callbackGasLimit);
    error InvalidRequestHash(bytes32 requestHash);
    error InvalidDeadline(uint256 deadline);
    error InsufficientGas();
    error InvalidBeacon(address beacon);

    /// @notice Compute the total request price
    /// @param callbackGasLimit The callback gas limit that will be used for
    ///     the randomness request
    function getRequestPrice(
        uint256 callbackGasLimit
    ) external view returns (uint256 totalPrice, uint256 effectiveFeePerGas);

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
