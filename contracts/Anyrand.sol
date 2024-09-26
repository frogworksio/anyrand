// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.23;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {BLS} from "@kevincharm/bls-bn254/contracts/BLS.sol";
import {Gas} from "./lib/Gas.sol";
import {IRandomiserCallback} from "./interfaces/IRandomiserCallback.sol";
import {AnyrandStorage} from "./AnyrandStorage.sol";
import {IGasStation} from "./interfaces/IGasStation.sol";
import {IDrandBeacon} from "./interfaces/IDrandBeacon.sol";

/// @title Anyrand
/// @author Kevin Charm (kevin@frogworks.io)
/// @notice Coordinator for requesting and receiving verified randomness from
///     a drand (https://drand.love) beacon.
contract Anyrand is AnyrandStorage, Ownable {
    /// @notice Domain separation tag
    bytes public constant DST =
        bytes("BLS_SIG_BN254G1_XMD:KECCAK-256_SVDW_RO_NUL_");

    constructor(
        address beacon_,
        uint256 initialRequestPrice,
        uint256 maxCallbackGasLimit_,
        uint256 maxDeadlineDelta_,
        address gasStation_
    ) Ownable(msg.sender) {
        MainStorage storage $ = _getMainStorage();

        $.beacon = beacon_;
        emit BeaconUpdated(beacon_);

        $.baseRequestPrice = initialRequestPrice;
        emit RequestPriceUpdated(initialRequestPrice);

        $.maxCallbackGasLimit = maxCallbackGasLimit_;
        emit MaxCallbackGasLimitUpdated(maxCallbackGasLimit_);

        $.maxDeadlineDelta = maxDeadlineDelta_;
        emit MaxDeadlineDeltaUpdated(maxDeadlineDelta_);

        $.gasStation = gasStation_;
        emit GasStationUpdated(gasStation_);
    }

    /// @notice See {ITypeAndVersion-typeAndVersion}
    function typeAndVersion() external pure returns (string memory) {
        return "Anyrand 1.0.0";
    }

    /// @notice Assert that the reentrance lock is not set
    function _assertNoReentrance() internal view {
        MainStorage storage $ = _getMainStorage();
        if ($.reentranceLock) {
            revert Reentrant();
        }
    }

    /// @notice Compute keccak256 of a request
    /// @param requestId Request id, acts as a nonce
    /// @param requester Address of contract that initiated the request.
    /// @param pubKeyHash hash of the beacon's public key
    /// @param round Target round of the drand beacon.
    /// @param callbackGasLimit Gas limit for callback
    function hashRequest(
        uint256 requestId,
        address requester,
        bytes32 pubKeyHash,
        uint256 round,
        uint256 callbackGasLimit
    ) internal view returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    block.chainid,
                    address(this),
                    requestId,
                    requester,
                    pubKeyHash,
                    round,
                    callbackGasLimit
                )
            );
    }

    /// @notice Withdraw ETH
    /// @param amount Amount of ETH (in wei) to withdraw. Input 0
    ///     to withdraw entire balance
    function withdrawETH(uint256 amount) external onlyOwner {
        if (amount == 0) {
            amount = address(this).balance;
        }
        (bool success, ) = msg.sender.call{value: amount}("");
        if (!success) {
            revert TransferFailed(msg.sender, amount);
        }
        emit ETHWithdrawn(amount);
    }

    /// @notice Compute the total request price.
    /// @param callbackGasLimit The callback gas limit that will be used for
    ///     the randomness request
    function getRequestPrice(
        uint256 callbackGasLimit
    ) public view virtual returns (uint256) {
        MainStorage storage $ = _getMainStorage();
        return
            $.baseRequestPrice +
            IGasStation($.gasStation).getTxCost(callbackGasLimit);
    }

    /// @notice Request randomness
    /// @param deadline Timestamp of when the randomness should be fulfilled. A
    ///     beacon round closest to this timestamp (rounding up to the nearest
    ///     future round) will be used as the round from which to derive
    ///     randomness.
    /// @param callbackGasLimit Gas limit for callback
    function requestRandomness(
        uint256 deadline,
        uint256 callbackGasLimit
    ) external payable override returns (uint256) {
        _assertNoReentrance();
        MainStorage storage $ = _getMainStorage();
        uint256 reqPrice = getRequestPrice(callbackGasLimit);
        if (msg.value != reqPrice) {
            revert IncorrectPayment(msg.value, reqPrice);
        }
        if (callbackGasLimit > $.maxCallbackGasLimit) {
            revert OverGasLimit(callbackGasLimit);
        }
        if (deadline > block.timestamp + $.maxDeadlineDelta) {
            revert InvalidDeadline(deadline);
        }

        uint256 requestId = $.nextRequestId++;

        IDrandBeacon beacon = IDrandBeacon($.beacon);
        // Calculate nearest round from deadline (rounding to the future)
        if (
            (deadline < beacon.genesisTimestamp()) ||
            deadline < (block.timestamp + beacon.period())
        ) {
            revert InvalidDeadline(deadline);
        }
        uint256 delta = deadline - beacon.genesisTimestamp();
        uint64 round = uint64(
            (delta / beacon.period()) + (delta % beacon.period())
        );

        $.requests[requestId] = hashRequest(
            requestId,
            msg.sender,
            beacon.getPublicKeyHash(),
            round,
            callbackGasLimit
        );

        emit RandomnessRequested(
            requestId,
            msg.sender,
            round,
            callbackGasLimit,
            reqPrice
        );

        return requestId;
    }

    /// @notice Deserialise the public key from raw bytes for ecpairing
    function _deserialisePublicKey() private view returns (uint256[4] memory) {
        (
            uint256 pubKey0,
            uint256 pubKey1,
            uint256 pubKey2,
            uint256 pubKey3
        ) = abi.decode(
                IDrandBeacon(_getMainStorage().beacon).getPublicKey(),
                (uint256, uint256, uint256, uint256)
            );
        return [pubKey0, pubKey1, pubKey2, pubKey3];
    }

    /// @notice Verify the signature produced by a drand beacon round against
    ///     the known public key. Reverts if the signature is invalid.
    /// @param round The beacon round to verify
    /// @param signature The beacon signature
    function _verifyBeaconRound(
        uint256 round,
        uint256[2] calldata signature
    ) private view {
        // Encode round for hash-to-point
        bytes memory hashedRoundBytes = new bytes(32);
        assembly {
            mstore(0x00, round)
            let hashedRound := keccak256(0x18, 0x08) // hash the last 8 bytes (uint64) of `round`
            mstore(add(0x20, hashedRoundBytes), hashedRound)
        }

        uint256[4] memory pubKey = _deserialisePublicKey();
        uint256[2] memory message = BLS.hashToPoint(DST, hashedRoundBytes);
        bool isValidSignature = BLS.isValidSignature(signature);
        (bool pairingSuccess, bool callSuccess) = BLS.verifySingle(
            signature,
            pubKey,
            message
        );
        if (!isValidSignature || !pairingSuccess || !callSuccess) {
            revert InvalidSignature(pubKey, message, signature);
        }
    }

    /// @notice Fulfill a randomness request (for beacon keepers)
    /// @param requestId Which request id to fulfill
    /// @param requester Address of account that initiated the request.
    /// @param round Target round of the drand beacon.
    /// @param callbackGasLimit Gas limit for callback
    /// @param signature Beacon signature of the round, from which randomness
    ///     is derived.
    function fulfillRandomness(
        uint256 requestId,
        address requester,
        bytes32 pubKeyHash,
        uint256 round,
        uint256 callbackGasLimit,
        uint256[2] calldata signature
    ) external {
        _assertNoReentrance();
        MainStorage storage $ = _getMainStorage();
        bytes32 reqHash = hashRequest(
            requestId,
            requester,
            pubKeyHash,
            round,
            callbackGasLimit
        );
        if ($.requests[requestId] != reqHash) {
            revert InvalidRequestHash(reqHash);
        }
        // Nullify the request hash optimistically
        // Note that we restore this hash if the callback fails.
        $.requests[requestId] = bytes32(0);

        // Beacon verification
        _verifyBeaconRound(round, signature);

        // Derive randomness from the signature
        uint256[] memory randomWords = new uint256[](1);
        randomWords[0] = uint256(
            keccak256(
                abi.encode(
                    keccak256(
                        abi.encode(signature[0], signature[1])
                    ) /** entropy */,
                    requestId /** salt */,
                    requester /** salt */
                )
            )
        );

        bool didCallbackSucceed = callWithExactGas(
            callbackGasLimit,
            requester,
            requestId,
            randomWords
        );
        if (!didCallbackSucceed) {
            // Allow the fulfiller to retry this request
            $.requests[requestId] = reqHash;
            bytes32 retdata;
            assembly {
                // Copy a maximum of 32B from returndata, to ease debugging
                returndatacopy(0, 0, 32)
                retdata := mload(0)
            }
            emit RandomnessCallbackFailed(requestId, retdata);
        }

        emit RandomnessFulfilled(requestId, randomWords, didCallbackSucceed);
    }

    /// @dev Non-reentrant callWithExactGas
    function callWithExactGas(
        uint256 callbackGasLimit,
        address requester,
        uint256 requestId,
        uint256[] memory randomWords
    ) private returns (bool success) {
        MainStorage storage $ = _getMainStorage();
        $.reentranceLock = true;
        success = Gas.callWithExactGas(
            callbackGasLimit,
            requester,
            abi.encodePacked(
                IRandomiserCallback.receiveRandomWords.selector,
                abi.encode(requestId, randomWords)
            )
        );
        $.reentranceLock = false;
    }

    ///////////////////////////////////////////////////////////////////////////
    /// Privileged setters ////////////////////////////////////////////////////
    ///////////////////////////////////////////////////////////////////////////

    /// @notice Update request price
    /// @param newPrice The new price
    function setBaseRequestPrice(uint256 newPrice) external onlyOwner {
        MainStorage storage $ = _getMainStorage();
        $.baseRequestPrice = newPrice;
        emit RequestPriceUpdated(newPrice);
    }

    /// @notice Update max callback gas limit
    /// @param newMaxCallbackGasLimit The new max callback gas limit
    function setMaxCallbackGasLimit(
        uint256 newMaxCallbackGasLimit
    ) external onlyOwner {
        MainStorage storage $ = _getMainStorage();
        $.maxCallbackGasLimit = newMaxCallbackGasLimit;
        emit MaxCallbackGasLimitUpdated(newMaxCallbackGasLimit);
    }

    /// @notice Update max deadline delta
    /// @param newMaxDeadlineDelta The new max deadline delta
    function setMaxDeadlineDelta(
        uint256 newMaxDeadlineDelta
    ) external onlyOwner {
        MainStorage storage $ = _getMainStorage();
        $.maxDeadlineDelta = newMaxDeadlineDelta;
        emit MaxDeadlineDeltaUpdated(newMaxDeadlineDelta);
    }

    /// @notice Set the gas station
    /// @param newGasStation The new gas station
    function setGasStation(address newGasStation) external onlyOwner {
        MainStorage storage $ = _getMainStorage();
        $.gasStation = newGasStation;
        emit GasStationUpdated(newGasStation);
    }
}
