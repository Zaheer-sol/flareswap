// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {IFlareContractRegistry} from "../interfaces/IFlareContractRegistry.sol";

/// @notice Test double for the canonical FlareContractRegistry.
contract MockFlareContractRegistry is IFlareContractRegistry {
    mapping(bytes32 nameHash => address) private _addresses;
    string[] private _names;

    function setContractAddress(string calldata name, address addr) external {
        bytes32 nameHash = keccak256(abi.encode(name));
        if (_addresses[nameHash] == address(0)) _names.push(name);
        _addresses[nameHash] = addr;
    }

    function getContractAddressByName(string calldata name) external view returns (address) {
        return _addresses[keccak256(abi.encode(name))];
    }

    function getContractAddressByHash(bytes32 nameHash) external view returns (address) {
        return _addresses[nameHash];
    }

    function getAllContracts() external view returns (string[] memory names, address[] memory addresses) {
        names = _names;
        addresses = new address[](_names.length);
        for (uint256 i = 0; i < _names.length; i++) {
            addresses[i] = _addresses[keccak256(abi.encode(_names[i]))];
        }
    }
}
