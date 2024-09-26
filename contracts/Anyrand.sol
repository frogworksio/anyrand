// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.23;

import {OwnableRoles} from "solady/src/auth/OwnableRoles.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
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
contract Anyrand is AnyrandStorage, OwnableRoles, UUPSUpgradeable {
    /// @notice Domain separation tag
    bytes public constant DST =
        bytes("BLS_SIG_BN254G1_XMD:KECCAK-256_SVDW_RO_NUL_");

    /// @notice Role to upgrade the contract
    uint256 public constant UPGRADER_ROLE = _ROLE_0;
    /// @notice Role to do accounting stuff e.g. withdraw ETH
    uint256 public constant ACCOUNTING_ROLE = _ROLE_1;
    /// @notice Role to set/change/upgrade the beacon
    uint256 public constant BEACON_ADMIN_ROLE = _ROLE_2;
    /// @notice Role to configure various parameters of the contract
    uint256 public constant CONFIGURATOR_ROLE = _ROLE_3;

    constructor() {
        _disableInitializers();
    }

    /// @notice Initialise the contract
    /// @param beacon_ The address of contract with drand beacon data
    /// @param initialRequestPrice The initial base request price
    /// @param maxCallbackGasLimit_ The maximum callback gas limit
    /// @param maxDeadlineDelta_ The maximum deadline delta
    /// @param gasStation_ The address of the gas station
    function init(
        address beacon_,
        uint256 initialRequestPrice,
        uint256 maxCallbackGasLimit_,
        uint256 maxDeadlineDelta_,
        address gasStation_
    ) public initializer {
        __UUPSUpgradeable_init();
        // OwnableRoles
        _initializeOwner(msg.sender);

        MainStorage storage $ = _getMainStorage();

        _setBeacon(beacon_);

        $.baseRequestPrice = initialRequestPrice;
        emit RequestPriceUpdated(initialRequestPrice);

        $.maxCallbackGasLimit = maxCallbackGasLimit_;
        emit MaxCallbackGasLimitUpdated(maxCallbackGasLimit_);

        $.maxDeadlineDelta = maxDeadlineDelta_;
        emit MaxDeadlineDeltaUpdated(maxDeadlineDelta_);

        $.gasStation = gasStation_;
        emit GasStationUpdated(gasStation_);
    }

    /// @inheritdoc UUPSUpgradeable
    function _authorizeUpgrade(
        address newImplementation
    ) internal override onlyRoles(UPGRADER_ROLE) {}

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
    function withdrawETH(uint256 amount) external onlyRoles(ACCOUNTING_ROLE) {
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

        uint256 reqPrice = getRequestPrice(callbackGasLimit);
        if (msg.value != reqPrice) {
            revert IncorrectPayment(msg.value, reqPrice);
        }

        MainStorage storage $ = _getMainStorage();
        if (callbackGasLimit > $.maxCallbackGasLimit) {
            revert OverGasLimit(callbackGasLimit);
        }
        if (deadline > block.timestamp + $.maxDeadlineDelta) {
            revert InvalidDeadline(deadline);
        }

        IDrandBeacon beacon = IDrandBeacon($.beacon);
        uint256 genesis = beacon.genesisTimestamp();
        uint256 period = beacon.period();
        // Calculate nearest round from deadline (rounding to the future)
        if ((deadline < genesis) || deadline < (block.timestamp + period)) {
            revert InvalidDeadline(deadline);
        }
        uint256 delta = deadline - genesis;
        uint64 round = uint64((delta / period) + (delta % period));

        uint256 requestId = $.nextRequestId++;
        $.requests[requestId] = hashRequest(
            requestId,
            msg.sender,
            beacon.publicKeyHash(),
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
                IDrandBeacon(_getMainStorage().beacon).publicKey(),
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

    /// @notice Set the beacon
    /// @param newBeacon The new beacon
    function _setBeacon(address newBeacon) private {
        // Sanity check
        IDrandBeacon beacon = IDrandBeacon(newBeacon);
        if (
            beacon.publicKey().length == 0 ||
            beacon.period() == 0 ||
            beacon.genesisTimestamp() == 0
        ) {
            revert InvalidBeacon(newBeacon);
        }

        MainStorage storage $ = _getMainStorage();
        $.beacon = newBeacon;
        emit BeaconUpdated(newBeacon);
    }

    ///////////////////////////////////////////////////////////////////////////
    /// Privileged setters ////////////////////////////////////////////////////
    ///////////////////////////////////////////////////////////////////////////

    /// @notice Set the beacon (privileged)
    /// @param newBeacon The new beacon
    function setBeacon(
        address newBeacon
    ) external onlyRoles(BEACON_ADMIN_ROLE) {
        _setBeacon(newBeacon);
    }

    /// @notice Update request price
    /// @param newPrice The new price
    function setBaseRequestPrice(
        uint256 newPrice
    ) external onlyRoles(CONFIGURATOR_ROLE) {
        MainStorage storage $ = _getMainStorage();
        $.baseRequestPrice = newPrice;
        emit RequestPriceUpdated(newPrice);
    }

    /// @notice Update max callback gas limit
    /// @param newMaxCallbackGasLimit The new max callback gas limit
    function setMaxCallbackGasLimit(
        uint256 newMaxCallbackGasLimit
    ) external onlyRoles(CONFIGURATOR_ROLE) {
        MainStorage storage $ = _getMainStorage();
        $.maxCallbackGasLimit = newMaxCallbackGasLimit;
        emit MaxCallbackGasLimitUpdated(newMaxCallbackGasLimit);
    }

    /// @notice Update max deadline delta
    /// @param newMaxDeadlineDelta The new max deadline delta
    function setMaxDeadlineDelta(
        uint256 newMaxDeadlineDelta
    ) external onlyRoles(CONFIGURATOR_ROLE) {
        MainStorage storage $ = _getMainStorage();
        $.maxDeadlineDelta = newMaxDeadlineDelta;
        emit MaxDeadlineDeltaUpdated(newMaxDeadlineDelta);
    }

    /// @notice Set the gas station
    /// @param newGasStation The new gas station
    function setGasStation(
        address newGasStation
    ) external onlyRoles(CONFIGURATOR_ROLE) {
        MainStorage storage $ = _getMainStorage();
        $.gasStation = newGasStation;
        emit GasStationUpdated(newGasStation);
    }
}
