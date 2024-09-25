// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.23;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {BLS} from "@kevincharm/bls-bn254/contracts/BLS.sol";
import {Gas} from "./lib/Gas.sol";
import {IRandomiserCallback} from "./interfaces/IRandomiserCallback.sol";
import {IAnyrand} from "./interfaces/IAnyrand.sol";
import {IGasStation} from "./interfaces/IGasStation.sol";

/// @title Anyrand by Fairy
/// @author kevincharm (k@fairy.dev)
contract Anyrand is IAnyrand, Ownable {
    /// @notice Domain separation tag
    bytes public constant DST =
        bytes("BLS_SIG_BN254G1_XMD:KECCAK-256_SVDW_RO_NUL_");

    /// @notice Group PK Re(x) in G2
    uint256 public immutable publicKey0;
    /// @notice Group PK Im(x) in G2
    uint256 public immutable publicKey1;
    /// @notice Group PK Re(y) in G2
    uint256 public immutable publicKey2;
    /// @notice Group PK Im(y) in G2
    uint256 public immutable publicKey3;
    /// @notice The beacon's period, in seconds
    uint256 public immutable period;
    /// @notice Genesis timestamp
    uint256 public immutable genesisTimestamp;

    /// @notice The base price of entropy
    uint256 public baseRequestPrice;
    /// @notice Maximum callback gas limit
    uint256 public maxCallbackGasLimit;
    /// @notice Maximum number of seconds in the future from which randomness
    ///     can be requested
    uint256 public maxDeadlineDelta;
    /// @notice Self-explanatory
    uint256 public nextRequestId;
    /// @notice Request hashes - see {Anyrand-hashRequest}
    mapping(uint256 requestId => bytes32) public requests;
    /// @notice Reentrance flag
    bool private reentranceLock;
    /// @notice Gas station
    address public gasStation;

    constructor(
        uint256[4] memory publicKey_,
        uint256 genesisTimestamp_,
        uint256 period_,
        uint256 initialRequestPrice,
        uint256 maxCallbackGasLimit_,
        uint256 maxDeadlineDelta_,
        address gasStation_
    ) Ownable(msg.sender) {
        if (!BLS.isValidPublicKey(publicKey_)) {
            revert InvalidPublicKey(publicKey_);
        }
        publicKey0 = publicKey_[0];
        publicKey1 = publicKey_[1];
        publicKey2 = publicKey_[2];
        publicKey3 = publicKey_[3];

        if (genesisTimestamp_ == 0 || period_ == 0) {
            revert InvalidBeaconConfiguration(genesisTimestamp_, period_);
        }
        genesisTimestamp = genesisTimestamp_;
        period = period_;

        baseRequestPrice = initialRequestPrice;
        emit RequestPriceUpdated(initialRequestPrice);

        maxCallbackGasLimit = maxCallbackGasLimit_;
        emit MaxCallbackGasLimitUpdated(maxCallbackGasLimit_);

        maxDeadlineDelta = maxDeadlineDelta_;
        emit MaxDeadlineDeltaUpdated(maxDeadlineDelta_);

        gasStation = gasStation_;
        emit GasStationUpdated(gasStation_);
    }

    /// @notice See {ITypeAndVersion-typeAndVersion}
    function typeAndVersion() external pure returns (string memory) {
        return "Anyrand 1.0.0";
    }

    /// @notice Assert that the reentrance lock is not set
    function _assertNoReentrance() internal view {
        if (reentranceLock) {
            revert Reentrant();
        }
    }

    /// @notice Return this beacon's public key as bytes
    function getPubKey() public view returns (bytes memory) {
        return abi.encodePacked(publicKey0, publicKey1, publicKey2, publicKey3);
    }

    /// @notice Compute keccak256 of a request
    /// @param requestId Request id, acts as a nonce
    /// @param requester Address of contract that initiated the request.
    /// @param round Target round of the drand beacon.
    function hashRequest(
        uint256 requestId,
        address requester,
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

    /// @notice Update request price
    /// @param newPrice The new price
    function setPrice(uint256 newPrice) external onlyOwner {
        baseRequestPrice = newPrice;
        emit RequestPriceUpdated(newPrice);
    }

    /// @notice Compute the total request price.
    /// @param callbackGasLimit The callback gas limit that will be used for
    ///     the randomness request
    function getRequestPrice(
        uint256 callbackGasLimit
    ) public view virtual returns (uint256) {
        return
            baseRequestPrice +
            IGasStation(gasStation).getTxCost(callbackGasLimit);
    }

    /// @notice Update max callback gas limit
    /// @param newMaxCallbackGasLimit The new max callback gas limit
    function setMaxCallbackGasLimit(
        uint256 newMaxCallbackGasLimit
    ) external onlyOwner {
        maxCallbackGasLimit = newMaxCallbackGasLimit;
        emit MaxCallbackGasLimitUpdated(newMaxCallbackGasLimit);
    }

    /// @notice Update max deadline delta
    /// @param newMaxDeadlineDelta The new max deadline delta
    function setMaxDeadlineDelta(
        uint256 newMaxDeadlineDelta
    ) external onlyOwner {
        maxDeadlineDelta = newMaxDeadlineDelta;
        emit MaxDeadlineDeltaUpdated(newMaxDeadlineDelta);
    }

    /// @notice Set the gas station
    /// @param newGasStation The new gas station
    function setGasStation(address newGasStation) external onlyOwner {
        gasStation = newGasStation;
        emit GasStationUpdated(newGasStation);
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
        uint256 reqPrice = getRequestPrice(callbackGasLimit);
        if (msg.value != reqPrice) {
            revert IncorrectPayment(msg.value, reqPrice);
        }
        if (callbackGasLimit > maxCallbackGasLimit) {
            revert OverGasLimit(callbackGasLimit);
        }
        if (deadline > block.timestamp + maxDeadlineDelta) {
            revert InvalidDeadline(deadline);
        }

        uint256 requestId = nextRequestId;
        nextRequestId++;

        // Calculate nearest round from deadline (rounding to the future)
        if (
            (deadline < genesisTimestamp) ||
            deadline < (block.timestamp + period)
        ) {
            revert InvalidDeadline(deadline);
        }
        uint256 delta = deadline - genesisTimestamp;
        uint64 round = uint64((delta / period) + (delta % period));

        requests[requestId] = hashRequest(
            requestId,
            msg.sender,
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

        uint256[4] memory pubKey = [
            publicKey0,
            publicKey1,
            publicKey2,
            publicKey3
        ];
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
        uint256 round,
        uint256 callbackGasLimit,
        uint256[2] calldata signature
    ) external {
        _assertNoReentrance();

        bytes32 reqHash = hashRequest(
            requestId,
            requester,
            round,
            callbackGasLimit
        );
        if (requests[requestId] != reqHash) {
            revert InvalidRequestHash(reqHash);
        }
        // Nullify the request hash optimistically
        // Note that we restore this hash if the callback fails.
        requests[requestId] = bytes32(0);

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
            requests[requestId] = reqHash;
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
        reentranceLock = true;
        success = Gas.callWithExactGas(
            callbackGasLimit,
            requester,
            abi.encodePacked(
                IRandomiserCallback.receiveRandomWords.selector,
                abi.encode(requestId, randomWords)
            )
        );
        reentranceLock = false;
    }
}
