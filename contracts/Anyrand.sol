// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.23;

import {OwnableRoles} from "solady/src/auth/OwnableRoles.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {Gas} from "./lib/Gas.sol";
import {IRandomiserCallback} from "./interfaces/IRandomiserCallback.sol";
import {AnyrandStorage} from "./AnyrandStorage.sol";
import {IGasStation} from "./interfaces/IGasStation.sol";
import {IDrandBeacon} from "./interfaces/IDrandBeacon.sol";

/// @title Anyrand
/// @author Kevin Charm (kevin@frogworks.io)
/// @notice Coordinator for requesting and receiving verified randomness from
///     a drand (https://drand.love) beacon.
contract Anyrand is
    AnyrandStorage,
    OwnableRoles,
    UUPSUpgradeable,
    ReentrancyGuardUpgradeable
{
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
    /// @param requestPremiumMultiplierBps_ The percentage multiplier applied
    ///     to the raw tx cost
    /// @param maxCallbackGasLimit_ The maximum callback gas limit
    /// @param maxDeadlineDelta_ The maximum deadline delta
    /// @param gasStation_ The address of the gas station
    /// @param maxFeePerGas_ The maximum effective fee per gas for requests
    function init(
        address beacon_,
        uint256 requestPremiumMultiplierBps_,
        uint256 maxCallbackGasLimit_,
        uint256 maxDeadlineDelta_,
        address gasStation_,
        uint256 maxFeePerGas_
    ) public initializer {
        __UUPSUpgradeable_init();
        // OwnableRoles
        _initializeOwner(msg.sender);

        MainStorage storage $ = _getMainStorage();

        _setBeacon(beacon_);

        $.nextRequestId = 1;

        $.requestPremiumMultiplierBps = requestPremiumMultiplierBps_;
        emit RequestPremiumMultiplierUpdated(requestPremiumMultiplierBps_);

        $.maxCallbackGasLimit = maxCallbackGasLimit_;
        emit MaxCallbackGasLimitUpdated(maxCallbackGasLimit_);

        $.maxDeadlineDelta = maxDeadlineDelta_;
        emit MaxDeadlineDeltaUpdated(maxDeadlineDelta_);

        $.gasStation = gasStation_;
        emit GasStationUpdated(gasStation_);

        $.maxFeePerGas = maxFeePerGas_;
        emit MaxFeePerGasUpdated(maxFeePerGas_);
    }

    /// @inheritdoc UUPSUpgradeable
    function _authorizeUpgrade(
        address newImplementation
    ) internal override onlyRoles(UPGRADER_ROLE) {}

    /// @notice See {ITypeAndVersion-typeAndVersion}
    function typeAndVersion() external pure returns (string memory) {
        return "Anyrand 1.0.0";
    }

    /// @notice Compute keccak256 of a request
    /// @param requestId Request id, acts as a nonce
    /// @param requester Address of contract that initiated the request.
    /// @param pubKeyHash hash of the beacon's public key
    /// @param round Target round of the drand beacon.
    /// @param callbackGasLimit Gas limit for callback
    function _hashRequest(
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
    ) public view virtual returns (uint256, uint256) {
        MainStorage storage $ = _getMainStorage();
        (uint256 rawTxCost, uint256 effectiveFeePerGas) = IGasStation(
            $.gasStation
        ).getTxCost(
                200_000 /** fulfillRandomness overhead */ + callbackGasLimit
            );
        uint256 totalCost = (rawTxCost * $.requestPremiumMultiplierBps) / 1e4;
        return (totalCost, effectiveFeePerGas);
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
    ) external payable override nonReentrant returns (uint256) {
        (uint256 reqPrice, uint256 effectiveFeePerGas) = getRequestPrice(
            callbackGasLimit
        );
        MainStorage storage $ = _getMainStorage();
        if (effectiveFeePerGas > $.maxFeePerGas) {
            // Cap gas price at maxFeePerGas (keeper will only fulfill when gas
            // price <= maxFeePerGas)
            // Importantly, fulfillment is permissionless, so it's possible to
            reqPrice = $.maxFeePerGas * callbackGasLimit;
            effectiveFeePerGas = $.maxFeePerGas;
        }
        if (msg.value != reqPrice) {
            revert IncorrectPayment(msg.value, reqPrice);
        }

        if (callbackGasLimit > $.maxCallbackGasLimit) {
            revert OverGasLimit(callbackGasLimit);
        }

        bytes32 pubKeyHash;
        uint64 round;
        {
            IDrandBeacon drandBeacon = IDrandBeacon($.beacon);
            pubKeyHash = drandBeacon.publicKeyHash();
            uint256 genesis = drandBeacon.genesisTimestamp();
            uint256 period = drandBeacon.period();
            if (
                (deadline > block.timestamp + $.maxDeadlineDelta) ||
                (deadline < genesis) ||
                deadline < (block.timestamp + period)
            ) {
                revert InvalidDeadline(deadline);
            }
            // Calculate nearest round from deadline (rounding to the future)
            uint256 delta = deadline - genesis;
            round = uint64((delta / period) + (delta % period));
        }

        uint256 requestId = $.nextRequestId++;
        $.requests[requestId] = _hashRequest(
            requestId,
            msg.sender,
            pubKeyHash,
            round,
            callbackGasLimit
        );

        emit RandomnessRequested(
            requestId,
            msg.sender,
            pubKeyHash,
            round,
            callbackGasLimit,
            reqPrice,
            effectiveFeePerGas
        );

        return requestId;
    }

    /// @notice Call a function, forwarding an exact amount of gas, whilst also
    ///     measuring how much gas was actually used.
    /// @param callbackGasLimit The amount of gas to use
    /// @param target The address to call
    /// @param data The data to send
    /// @return success Whether the call succeeded
    /// @return gasUsed The amount of gas used
    function _callWithExactGas(
        uint256 callbackGasLimit,
        address target,
        bytes memory data
    ) private returns (bool success, uint256 gasUsed) {
        gasUsed = gasleft();
        success = Gas.callWithExactGas(callbackGasLimit, target, data);
        gasUsed -= gasleft();
    }

    /// @notice Fulfill a randomness request (for beacon keepers).
    /// @notice Note that fulfilment only depends on the validity of the BLS
    ///     signature over the expected beacon round, and DOES NOT check
    ///     the block timestamp against that round.
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
    ) external nonReentrant {
        MainStorage storage $ = _getMainStorage();
        bytes32 reqHash = _hashRequest(
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
        IDrandBeacon($.beacon).verifyBeaconRound(round, signature);

        // Derive randomness from the signature
        uint256[] memory randomWords = new uint256[](1);
        randomWords[0] = uint256(
            keccak256(
                abi.encode(
                    signature[0] /** entropy */,
                    signature[1] /** entropy */,
                    block.chainid /** domain separator */,
                    address(this) /** salt */,
                    requestId /** salt */,
                    requester /** salt */
                )
            )
        );

        (bool didCallbackSucceed, uint256 gasUsed) = _callWithExactGas(
            callbackGasLimit,
            requester,
            abi.encodePacked(
                IRandomiserCallback.receiveRandomWords.selector,
                abi.encode(requestId, randomWords)
            )
        );
        if (!didCallbackSucceed) {
            // Allow the fulfiller to retry this request
            $.requests[requestId] = reqHash;
            bytes32 retdata;
            assembly {
                function min(a, b) -> c {
                    switch lt(a, b)
                    case 1 {
                        c := a
                    }
                    default {
                        c := b
                    }
                }

                mstore(0, 0)
                // Copy a maximum of 32B from returndata, to ease debugging
                let r := returndatasize()
                returndatacopy(0, 0, min(r, 32))
                retdata := mload(0)
            }
            emit RandomnessCallbackFailed(
                requestId,
                retdata,
                callbackGasLimit,
                gasUsed
            );
        }

        emit RandomnessFulfilled(
            requestId,
            randomWords,
            didCallbackSucceed,
            gasUsed
        );
    }

    /// @notice Set the beacon
    /// @param newBeacon The new beacon
    function _setBeacon(address newBeacon) internal {
        // Sanity check
        try IDrandBeacon(newBeacon).publicKey() returns (bytes memory pubKey) {
            if (pubKey.length == 0) revert InvalidBeacon(newBeacon);
        } catch {
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
    /// @param newRequestPremiumMultiplierBps The new request premium multiplier
    function setRequestPremiumMultiplierBps(
        uint256 newRequestPremiumMultiplierBps
    ) external onlyRoles(CONFIGURATOR_ROLE) {
        MainStorage storage $ = _getMainStorage();
        $.requestPremiumMultiplierBps = newRequestPremiumMultiplierBps;
        emit RequestPremiumMultiplierUpdated(newRequestPremiumMultiplierBps);
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
