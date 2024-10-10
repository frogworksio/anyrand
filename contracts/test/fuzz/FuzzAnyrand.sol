// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import {hevm} from "../IHevm.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IAnyrand} from "../../interfaces/IAnyrand.sol";
import {IRandomiserCallbackV3} from "../../interfaces/IRandomiserCallbackV3.sol";
import {Anyrand} from "../../Anyrand.sol";
import {IDrandBeacon} from "../../interfaces/IDrandBeacon.sol";
import {AlwaysVerifiesBeacon} from "../AlwaysVerifiesBeacon.sol";
import {GasStationEthereum} from "../../networks/GasStationEthereum.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

/// @notice Echidna fuzzing harness for Anyrand
contract FuzzAnyrand is IRandomiserCallbackV3 {
    using Strings for uint256;
    using Strings for address;
    using Strings for bytes32;
    event DebugLog(string msg);
    event AssertionFailed(string reason);

    struct Request {
        uint256 requestId;
        address requester;
        bytes32 pubKeyHash;
        uint256 round;
        uint256 callbackGasLimit;
    }

    address internal immutable owner = address(this);
    Anyrand internal anyrand;
    IDrandBeacon internal beacon;
    GasStationEthereum internal gasStation;

    uint256 internal immutable premiumBps = 2e4; // 200%
    uint256 internal immutable maxCallbackGasLimit = 7_500_000;
    uint256 internal immutable maxDeadlineDelta = 30; // 30s
    uint256 internal immutable maxFeePerGas = 10 gwei;
    uint256 internal lastRequestId;
    mapping(uint256 requestId => uint256 count) internal fulfilmentCount;
    mapping(uint256 requestId => Request) internal myRequests;

    constructor() {
        beacon = IDrandBeacon(
            new AlwaysVerifiesBeacon(
                hex"deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
                1727521075,
                3
            )
        );
        gasStation = new GasStationEthereum();
        ERC1967Proxy proxy = new ERC1967Proxy(
            address(new Anyrand()),
            abi.encodeWithSelector(
                Anyrand.init.selector,
                beacon,
                premiumBps,
                maxCallbackGasLimit,
                maxDeadlineDelta,
                gasStation,
                maxFeePerGas
            )
        );
        anyrand = Anyrand(payable(proxy));
    }

    function assertWithMsg(bool condition, string memory reason) internal {
        if (!condition) {
            emit AssertionFailed(reason);
        }
    }

    ///////////////////////////////////////////////////////////////////////////
    /// TESTS /////////////////////////////////////////////////////////////////
    ///////////////////////////////////////////////////////////////////////////

    /// @notice Should only be called through fulfillRandomness callback
    /// Invariant: only-once delivery
    function receiveRandomness(uint256 requestId, uint256) external {
        require(msg.sender == address(anyrand));
        assert(
            anyrand.getRequestState(requestId) == IAnyrand.RequestState.Pending
        );

        fulfilmentCount[requestId] += 1;
        assertWithMsg(fulfilmentCount[requestId] <= 1, "Double fulfilment");
    }

    function requestRandomness(
        uint256 deadline,
        uint256 callbackGasLimit
    ) external {
        uint256 genesis = beacon.genesisTimestamp();
        uint256 period = beacon.period();
        deadline = genesis + period + (deadline % (maxDeadlineDelta - period));
        callbackGasLimit = callbackGasLimit % maxCallbackGasLimit;
        (uint256 price, ) = anyrand.getRequestPrice(callbackGasLimit);
        // uint256 requestId = anyrand.requestRandomness{value: price}(
        //     deadline,
        //     callbackGasLimit
        // );
        (bool success, bytes memory retdata) = address(anyrand).call{
            value: price
        }(
            abi.encodeWithSelector(
                Anyrand.requestRandomness.selector,
                deadline,
                callbackGasLimit
            )
        );
        assertWithMsg(
            success,
            string.concat(
                "requestRandomness call failed: ",
                uint256(bytes32(retdata)).toHexString()
            )
        );
        uint256 requestId = abi.decode(retdata, (uint256));
        assert(requestId > lastRequestId);
        lastRequestId = requestId;

        uint256 delta = deadline - genesis;
        uint256 round = uint64((delta / period) + (delta % period));
        myRequests[requestId] = Request(
            requestId,
            address(this),
            beacon.publicKeyHash(),
            round,
            callbackGasLimit
        );
        assert(
            anyrand.getRequestState(requestId) == IAnyrand.RequestState.Pending
        );
    }

    function fulfillRandomness(uint256 requestId) external {
        require(lastRequestId > 0, "No requests to fulfill");
        requestId = 1 + (requestId % anyrand.nextRequestId());
        Request memory request = myRequests[requestId];
        anyrand.fulfillRandomness(
            requestId,
            request.requester,
            request.pubKeyHash,
            request.round,
            request.callbackGasLimit,
            [uint256(420), uint256(69)] // These can be whatever since the beacon is a mock
        );
        assert(
            anyrand.getRequestState(requestId) ==
                IAnyrand.RequestState.Fulfilled
        );
    }

    ///////////////////////////////////////////////////////////////////////////
    /// PROPERTIES ////////////////////////////////////////////////////////////
    ///////////////////////////////////////////////////////////////////////////

    function test_requestIdIncreases() external {
        uint256 requestId = anyrand.nextRequestId();
        assert(requestId >= lastRequestId);
        lastRequestId = requestId;
    }

    function test_requestHashOnlyDefinedWhenRequestPending(
        uint256 requestId
    ) external view {
        requestId = requestId % anyrand.nextRequestId();

        bytes32 requestHash = anyrand.requests(lastRequestId);
        IAnyrand.RequestState state = anyrand.getRequestState(lastRequestId);
        if (requestHash != bytes32(0)) {
            assert(state == IAnyrand.RequestState.Pending);
        } else {
            assert(state != IAnyrand.RequestState.Pending);
        }
    }
}
