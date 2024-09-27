// SPDX-License-Identifier: MIT
pragma solidity ^0.8;

import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

contract Dummy {
    function daddy() external pure returns (string memory) {
        return "Vitamin Buttermilk";
    }
}
