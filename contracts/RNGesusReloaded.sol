// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.23;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {BLS} from "./bls/BLS.sol";
import {IRandomiserCallback} from "./interfaces/IRandomiserCallback.sol";
import {IRNGesusReloaded} from "./interfaces/IRNGesusReloaded.sol";

/// @title RNGesusReloaded
contract RNGesusReloaded is IRNGesusReloaded, Ownable {
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

    /// @notice The price of entropy
    uint256 public requestPrice;
    /// @notice Self-explanatory
    uint256 public nextRequestId;
    /// @notice Request hashes - see {RNGesusReloaded-hashRequest}
    mapping(uint256 requestId => bytes32) public requests;

    event RandomnessRequested(
        uint256 indexed requestId,
        address requester,
        uint256 round,
        address callbackContract
    );
    event RandomnessFulfilled(uint256 indexed requestId, uint256[] randomWords);
    event RequestPriceUpdated(uint256 newPrice);
    event ETHWithdrawn(uint256 amount);

    error TransferFailed();
    error IncorrectPayment();
    error InvalidRequestHash();
    error InvalidSignature();
    error InvalidPublicKey(uint256[4] pubKey);
    error InvalidBeaconConfiguration();
    error InvalidDeadline();

    constructor(
        uint256[4] memory publicKey_,
        uint256 genesisTimestamp_,
        uint256 period_,
        uint256 initialRequestPrice
    ) Ownable(msg.sender) {
        if (!BLS.isValidPublicKey(publicKey_)) {
            revert InvalidPublicKey(publicKey_);
        }
        publicKey0 = publicKey_[0];
        publicKey1 = publicKey_[1];
        publicKey2 = publicKey_[2];
        publicKey3 = publicKey_[3];

        if (genesisTimestamp_ == 0 || period_ == 0) {
            revert InvalidBeaconConfiguration();
        }
        genesisTimestamp = genesisTimestamp_;
        period = period_;

        requestPrice = initialRequestPrice;
        emit RequestPriceUpdated(initialRequestPrice);
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
    /// @param requester Address of account that initiated the request.
    /// @param round Target round of the drand beacon.
    /// @param callbackContract Address of contract that should receive the
    ///     callback, implementing the {IRandomiserCallback} interface.
    function hashRequest(
        uint256 requestId,
        address requester,
        uint256 round,
        address callbackContract
    ) internal view returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    block.chainid,
                    address(this),
                    requestId,
                    requester,
                    round,
                    callbackContract
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
            revert TransferFailed();
        }
        emit ETHWithdrawn(amount);
    }

    /// @notice Update request price
    /// @param newPrice The new price
    function setPrice(uint256 newPrice) external onlyOwner {
        requestPrice = newPrice;
        emit RequestPriceUpdated(newPrice);
    }

    /// @notice Request randomness
    /// TODO: Add callback gas limit
    /// @param deadline Timestamp of when the randomness should be fulfilled. A
    ///     beacon round closest to this timestamp (rounding up to the nearest
    ///     future round) will be used as the round from which to derive
    ///     randomness.
    /// @param callbackContract Address of contract that should receive the
    ///     callback, implementing the {IRandomiserCallback} interface.
    function requestRandomness(
        uint256 deadline,
        address callbackContract
    ) external payable override returns (uint256) {
        if (msg.value != requestPrice) {
            revert IncorrectPayment();
        }

        uint256 requestId = nextRequestId;
        nextRequestId++;

        // Calculate nearest round from deadline (rounding to the future)
        if (
            (deadline < genesisTimestamp) ||
            deadline < (block.timestamp + period)
        ) {
            revert InvalidDeadline();
        }
        uint256 delta = deadline - genesisTimestamp;
        uint64 round = uint64((delta / period) + (delta % period));

        requests[requestId] = hashRequest(
            requestId,
            msg.sender,
            round,
            callbackContract
        );

        emit RandomnessRequested(
            requestId,
            msg.sender,
            round,
            callbackContract
        );

        return requestId;
    }

    /// @notice Fulfill a randomness request (for beacon keepers)
    /// @param requestId Which request id to fulfill
    /// @param requester Address of account that initiated the request.
    /// @param round Target round of the drand beacon.
    /// @param callbackContract Address of contract that should receive the
    ///     callback, implementing the {IRandomiserCallback} interface.
    /// @param signature Beacon signature of the round, from which randomness
    ///     is derived.
    function fulfillRandomness(
        uint256 requestId,
        address requester,
        uint256 round,
        address callbackContract,
        uint256[2] calldata signature
    ) external {
        if (
            requests[requestId] !=
            hashRequest(requestId, requester, round, callbackContract)
        ) {
            revert InvalidRequestHash();
        }
        requests[requestId] = bytes32(0);

        // Encode round for hash-to-point
        bytes memory hashedRoundBytes = new bytes(32);
        assembly {
            mstore(0x00, round)
            let hashedRound := keccak256(0x18, 0x08) // hash the last 8 bytes (uint64) of `round`
            mstore(add(0x20, hashedRoundBytes), hashedRound)
        }

        uint256[2] memory message = BLS.hashToPoint(hashedRoundBytes);
        bool isValidSignature = BLS.isValidSignature(signature) &&
            BLS.verifySingle(signature, getPubKey(), message);
        if (!isValidSignature) {
            revert InvalidSignature();
        }

        uint256[] memory randomWords = new uint256[](1);
        randomWords[0] = uint256(
            keccak256(
                abi.encode(
                    keccak256(abi.encode(signature[0], signature[0])),
                    requestId,
                    requester
                )
            )
        );

        IRandomiserCallback(callbackContract).receiveRandomWords{gas: 500_000}(
            requestId,
            randomWords
        );

        emit RandomnessFulfilled(requestId, randomWords);
    }
}
