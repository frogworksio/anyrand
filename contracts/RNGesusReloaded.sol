// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.23;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {BLS} from "./bls/BLS.sol";
import {IRandomiserCallback} from "./interfaces/IRandomiserCallback.sol";

/// @title RNGesusReloaded
contract RNGesusReloaded is Ownable {
    struct DrandBeacon {
        /// @notice Group PK in G2
        uint256[4] publicKey;
        /// @notice The beacon's period, in seconds
        uint256 period;
        /// @notice Genesis timestamp
        uint256 genesisTimestamp;
    }

    /// @notice The price of entropy
    uint256 public requestPrice;
    /// @notice Self-explanatory
    uint256 public nextRequestId;
    /// @notice Request hashes - see {RNGesusReloaded-hashRequest}
    mapping(uint256 requestId => bytes32) public requests;
    /// @notice Registered drand beacons
    mapping(bytes32 pubKeyHash => DrandBeacon) public beacons;

    event RandomnessRequested(
        uint256 indexed requestId,
        bytes32 beaconPubKeyHash,
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

    constructor(uint256 initialRequestPrice) Ownable(msg.sender) {
        requestPrice = initialRequestPrice;
        emit RequestPriceUpdated(initialRequestPrice);
    }

    /// @notice Compute keccak256 of a public key
    /// @param publicKey Public key, a point on G2
    function hashPubKey(
        uint256[4] memory publicKey
    ) public pure returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    publicKey[0],
                    publicKey[1],
                    publicKey[2],
                    publicKey[3]
                )
            );
    }

    /// @notice Compute keccak256 of a request
    /// @param beaconPubKeyHash PKH of the beacon from which randomness will be
    ///     derived.
    /// @param requester Address of account that initiated the request.
    /// @param round Target round of the drand beacon.
    /// @param callbackContract Address of contract that should receive the
    ///     callback, implementing the {IRandomiserCallback} interface.
    function hashRequest(
        bytes32 beaconPubKeyHash,
        address requester,
        uint256 round,
        address callbackContract
    ) internal pure returns (bytes32) {
        return
            keccak256(
                abi.encode(beaconPubKeyHash, requester, round, callbackContract)
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

    function setPrice(uint256 newPrice) external onlyOwner {
        requestPrice = newPrice;
        emit RequestPriceUpdated(newPrice);
    }

    /// @notice Register drand beacon
    /// TODO: I think drand produces a signature on genesis, can use that to
    ///     verify correctness
    /// @param drandBeacon Beacon details
    function registerBeacon(
        DrandBeacon calldata drandBeacon
    ) external onlyOwner {
        bytes32 pubKeyHash = hashPubKey(drandBeacon.publicKey);
        beacons[pubKeyHash] = drandBeacon;
    }

    /// @notice Request randomness
    /// @param beaconPubKeyHash PKH of the beacon from which randomness will be
    ///     derived.
    /// @param deadline Timestamp of when the randomness should be fulfilled. A
    ///     beacon round closest to this timestamp (rounding up to the nearest
    ///     future round) will be used as the round from which to derive
    ///     randomness.
    /// @param callbackContract Address of contract that should receive the
    ///     callback, implementing the {IRandomiserCallback} interface.
    function requestRandomness(
        bytes32 beaconPubKeyHash,
        uint256 deadline,
        address callbackContract
    ) external payable returns (uint256) {
        if (msg.value != requestPrice) {
            revert IncorrectPayment();
        }

        DrandBeacon memory beacon = beacons[beaconPubKeyHash];
        require(beacon.genesisTimestamp != 0, "Unknown beacon");

        uint256 requestId = nextRequestId;
        nextRequestId++;

        // Calculate nearest round from deadline (rounding to the future)
        require(
            deadline >= block.timestamp + beacon.period,
            "Deadline must be in the future"
        );
        uint256 delta = deadline - beacon.genesisTimestamp;
        uint64 round = uint64(
            (delta / beacon.period) + (delta % beacon.period)
        );

        requests[requestId] = hashRequest(
            beaconPubKeyHash,
            msg.sender,
            round,
            callbackContract
        );

        emit RandomnessRequested(
            requestId,
            beaconPubKeyHash,
            msg.sender,
            round,
            callbackContract
        );

        return requestId;
    }

    /// @notice Fulfill a randomness request (for beacon keepers)
    /// @param requestId Which request id to fulfill
    /// @param beaconPubKeyHash PKH of the beacon from which randomness will be
    ///     derived.
    /// @param requester Address of account that initiated the request.
    /// @param round Target round of the drand beacon.
    /// @param callbackContract Address of contract that should receive the
    ///     callback, implementing the {IRandomiserCallback} interface.
    /// @param signature Beacon signature of the round, from which randomness
    ///     is derived.
    function fulfillRandomness(
        uint256 requestId,
        bytes32 beaconPubKeyHash,
        address requester,
        uint256 round,
        address callbackContract,
        uint256[2] calldata signature
    ) external {
        if (
            requests[requestId] !=
            hashRequest(beaconPubKeyHash, requester, round, callbackContract)
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
        bool isValidSignature = BLS.verifySingle(
            signature,
            beacons[beaconPubKeyHash].publicKey,
            message
        );
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
