// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable} from "solady/src/auth/Ownable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {Gas} from "./lib/Gas.sol";
import {ITypeAndVersion} from "./interfaces/ITypeAndVersion.sol";
import {IRandomiserCallbackV3} from "./interfaces/IRandomiserCallbackV3.sol";
import {AnyrandStorage} from "./AnyrandStorage.sol";
import {IGasStation} from "./interfaces/IGasStation.sol";
import {IDrandBeacon} from "./interfaces/IDrandBeacon.sol";

/// @title Anyrand
/// @author Kevin Charm (kevin@frogworks.io)
/// @notice Coordinator for requesting and receiving verified randomness from
///     a drand (https://drand.love) beacon.
contract Anyrand is
    AnyrandStorage,
    ITypeAndVersion,
    Ownable,
    UUPSUpgradeable,
    ReentrancyGuardUpgradeable
{
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
        // solady/auth/Ownable requires explicit initialisation
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
    ) internal override onlyOwner {}

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
    ) public view virtual returns (uint256, uint256) {
        MainStorage storage $ = _getMainStorage();
        (uint256 rawTxCost, uint256 effectiveFeePerGas) = IGasStation(
            $.gasStation
        ).getTxCost(
                200_000 /** fulfillRandomness overhead */ + callbackGasLimit
            );
        uint256 totalCost = (rawTxCost * $.requestPremiumMultiplierBps) / 1e4;
        if (effectiveFeePerGas > $.maxFeePerGas) {
            // Cap gas price at maxFeePerGas (keeper will only fulfill when gas
            // price <= maxFeePerGas)
            // Importantly, fulfilment is permissionless, so it's possible to
            // override this behaviour and fulfill randomness even when the
            // keeper refuses to.
            totalCost = $.maxFeePerGas * callbackGasLimit;
            effectiveFeePerGas = $.maxFeePerGas;
        }
        return (totalCost, effectiveFeePerGas);
    }

    /// @notice Request randomness. Note that the fulfilment of the request will
    ///     always be *after* the deadline, but never before.
    /// @param deadline Timestamp of when the randomness should be fulfilled. A
    ///     beacon round closest to this timestamp (rounding up to the nearest
    ///     future round) will be used as the round from which to derive
    ///     randomness.
    /// @param callbackGasLimit Gas limit for callback
    function requestRandomness(
        uint256 deadline,
        uint256 callbackGasLimit
    ) external payable override nonReentrant returns (uint256) {
        // Compute the total request price (including the premium) that will be
        // used to cover the keeper's costs
        (uint256 reqPrice, uint256 effectiveFeePerGas) = getRequestPrice(
            callbackGasLimit
        );
        if (msg.value != reqPrice) {
            revert IncorrectPayment(msg.value, reqPrice);
        }

        MainStorage storage $ = _getMainStorage();
        if (callbackGasLimit > $.maxCallbackGasLimit) {
            revert OverGasLimit(callbackGasLimit);
        }

        bytes32 pubKeyHash = $.currentBeaconPubKeyHash;
        // Here we find the nearest round
        uint64 round;
        {
            IDrandBeacon drandBeacon = IDrandBeacon($.beacons[pubKeyHash]);
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

        // Record the commitment of this request
        uint256 requestId = $.nextRequestId++;
        assert($.requestStates[requestId] == RequestState.Nonexistent);
        $.requestStates[requestId] = RequestState.Pending;
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

        // Ensure the request is in the correct state
        if ($.requestStates[requestId] != RequestState.Pending) {
            revert InvalidRequestState($.requestStates[requestId]);
        }

        // The inputs provided by the keeper must match the commitment we
        // recorded when the request was made.
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

        // Nullify the request hash; fulfilments must never be replayable
        $.requests[requestId] = bytes32(0);

        // Beacon verification: we check that the signature over the round is
        // valid for the given pubkey.
        IDrandBeacon($.beacons[pubKeyHash]).verifyBeaconRound(round, signature);

        // Derive randomness from the signature
        uint256 randomness = uint256(
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
                IRandomiserCallbackV3.receiveRandomness.selector,
                abi.encode(requestId, randomness)
            )
        );
        if (!didCallbackSucceed) {
            // The following code is to help debug any issues that occur in the
            // case that the callback fails.
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
            $.requestStates[requestId] = RequestState.Failed;
        } else {
            $.requestStates[requestId] = RequestState.Fulfilled;
        }

        emit RandomnessFulfilled(
            requestId,
            randomness,
            didCallbackSucceed,
            gasUsed
        );
    }

    /// @notice Get the state of a request
    /// @param requestId The request identifier
    function getRequestState(
        uint256 requestId
    ) external view returns (RequestState) {
        MainStorage storage $ = _getMainStorage();
        return $.requestStates[requestId];
    }

    /// @notice Add a new beacon and set the current beacon to it
    /// @param newBeacon The new beacon
    function _setBeacon(address newBeacon) internal {
        // Sanity check
        try IDrandBeacon(newBeacon).publicKeyHash() returns (
            bytes32 pubKeyHash
        ) {
            if (pubKeyHash == bytes32(0) || pubKeyHash == keccak256(hex"")) {
                revert InvalidBeacon(newBeacon);
            }

            // Looks good - add the beacon and update it
            MainStorage storage $ = _getMainStorage();
            $.beacons[pubKeyHash] = newBeacon;
            $.currentBeaconPubKeyHash = pubKeyHash;
            emit BeaconUpdated(newBeacon);
        } catch {
            revert InvalidBeacon(newBeacon);
        }
    }

    ///////////////////////////////////////////////////////////////////////////
    /// Privileged setters ////////////////////////////////////////////////////
    ///////////////////////////////////////////////////////////////////////////

    /// @notice Add a new beacon and set the current beacon to it (privileged)
    /// @notice This is intended to be used only in the case that the evmnet
    ///     beacon is deprecated in favour of the BLS12-381 beacon.
    /// @notice NB: This can replace/fix a beacon that is known to this
    ///     contract by its public key hash.
    /// @param newBeacon The new beacon
    function setBeacon(address newBeacon) external onlyOwner {
        _setBeacon(newBeacon);
    }

    /// @notice Update request price
    /// @param newRequestPremiumMultiplierBps The new request premium multiplier
    function setRequestPremiumMultiplierBps(
        uint256 newRequestPremiumMultiplierBps
    ) external onlyOwner {
        MainStorage storage $ = _getMainStorage();
        $.requestPremiumMultiplierBps = newRequestPremiumMultiplierBps;
        emit RequestPremiumMultiplierUpdated(newRequestPremiumMultiplierBps);
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
