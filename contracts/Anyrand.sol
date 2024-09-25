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
        bytes("BLS_SIG_BN254G1_XMD:KECCAK-256_SSWU_RO_NUL_");

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

    event RandomnessRequested(
        uint256 indexed requestId,
        address requester,
        uint256 round,
        uint256 callbackGasLimit,
        uint256 feePaid
    );
    event RandomnessFulfilled(uint256 indexed requestId, uint256[] randomWords);
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

    /// @notice Return this beacon's public key in memory
    function getPubKey() public view returns (uint256[4] memory) {
        uint256[4] memory pubKey;
        pubKey[0] = publicKey0;
        pubKey[1] = publicKey1;
        pubKey[2] = publicKey2;
        pubKey[3] = publicKey3;
        return pubKey;
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
        if (msg.value < reqPrice) {
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
        requests[requestId] = bytes32(0);

        // Encode round for hash-to-point
        bytes memory hashedRoundBytes = new bytes(32);
        assembly {
            mstore(0x00, round)
            let hashedRound := keccak256(0x18, 0x08) // hash the last 8 bytes (uint64) of `round`
            mstore(add(0x20, hashedRoundBytes), hashedRound)
        }

        uint256[4] memory pubKey = getPubKey();
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

        uint256[] memory randomWords = new uint256[](1);
        randomWords[0] = uint256(
            keccak256(
                abi.encode(
                    keccak256(abi.encode(signature[0], signature[1])),
                    requestId,
                    requester
                )
            )
        );

        callWithExactGas(callbackGasLimit, requester, requestId, randomWords);

        emit RandomnessFulfilled(requestId, randomWords);
    }

    function callWithExactGas(
        uint256 callbackGasLimit,
        address requester,
        uint256 requestId,
        uint256[] memory randomWords
    ) private {
        reentranceLock = true;
        Gas.callWithExactGas(
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
