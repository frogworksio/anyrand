// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.23;

import {IAnyrand} from "./interfaces/IAnyrand.sol";

/// @title AnyrandStorage
/// @author Kevin Charm (kevin@frogworks.io)
/// @notice Base abstract contract for Anyrand, defining storage layout and
///     external getter boilerplate.
abstract contract AnyrandStorage is IAnyrand {
    /// @custom:storage-location erc7201:io.frogworks.anyrand.v1.main_storage
    struct MainStorage {
        /// @notice Current beacon
        address beacon;
        /// @notice The base price of entropy
        uint256 requestPremiumBps;
        /// @notice Maximum callback gas limit
        uint256 maxCallbackGasLimit;
        /// @notice Maximum number of seconds in the future from which randomness
        ///     can be requested
        uint256 maxDeadlineDelta;
        /// @notice Self-explanatory
        uint256 nextRequestId;
        /// @notice Request hashes - see {Anyrand-hashRequest}
        mapping(uint256 requestId => bytes32 requestHash) requests;
        /// @notice Gas station
        address gasStation;
        /// @notice Maximum effective gas price (in wei) for requests
        uint256 maxFeePerGas;
    }

    /// @notice Get contract storage
    function _getMainStorage() internal pure returns (MainStorage storage $) {
        assembly {
            // (keccak256("io.frogworks.anyrand.v1.main_storage") - 1) & ~0xff
            $.slot := 0x73bb1f7ad954352194401771e442b57f02df3da05251c4536bf437f932f99200
        }
    }

    function beacon() external view returns (address) {
        return _getMainStorage().beacon;
    }

    function requestPremiumBps() external view returns (uint256) {
        return _getMainStorage().requestPremiumBps;
    }

    function maxCallbackGasLimit() external view returns (uint256) {
        return _getMainStorage().maxCallbackGasLimit;
    }

    function maxDeadlineDelta() external view returns (uint256) {
        return _getMainStorage().maxDeadlineDelta;
    }

    function nextRequestId() external view returns (uint256) {
        return _getMainStorage().nextRequestId;
    }

    function requests(uint256 requestId) external view returns (bytes32) {
        return _getMainStorage().requests[requestId];
    }

    function gasStation() external view returns (address) {
        return _getMainStorage().gasStation;
    }

    function maxFeePerGas() external view returns (uint256) {
        return _getMainStorage().maxFeePerGas;
    }
}
