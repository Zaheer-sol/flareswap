// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

/// @notice Canonical Flare contract registry.
/// @dev Deployed at the SAME address on Flare, Songbird, Coston and Coston2:
///      0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019
interface IFlareContractRegistry {
    /// @notice Returns the address of a Flare system contract by its registered name.
    /// @param _name e.g. "FtsoV2", "FdcVerification", "FdcRequestFeeConfigurations"
    /// @return Zero address if the name is not registered.
    function getContractAddressByName(string calldata _name) external view returns (address);

    /// @notice Returns the address of a Flare system contract by keccak256 of its name.
    function getContractAddressByHash(bytes32 _nameHash) external view returns (address);

    /// @notice Returns every registered (name, address) pair.
    function getAllContracts() external view returns (string[] memory, address[] memory);
}
