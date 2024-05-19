// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import {LibZip} from "solady/src/utils/LibZip.sol";

contract TestFlz {
    constructor(bytes memory data) {
        bytes memory compressed = LibZip.flzCompress(data);
        bytes memory ret = abi.encode(compressed);
        assembly {
            return(add(ret, 0x20), mload(ret))
        }
    }
}
