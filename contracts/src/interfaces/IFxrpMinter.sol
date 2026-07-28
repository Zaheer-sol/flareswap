// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {IPayment} from "./IPayment.sol";

/// @notice Abstraction over "turn an attested underlying payment into ERC-20 FAssets on Flare".
/// @dev Two implementations ship with FlareSwap:
///      - {FAssetsMinter}     production path, calls `IAssetManager.executeMinting`
///      - {PooledFxrpMinter}  testnet/demo path, releases pre-minted FXRP from a reserve
///      {IntentSettler} only ever talks to this interface, so the two are hot-swappable.
interface IFxrpMinter {
    error MinterNotAuthorized(address caller);
    error MintFailed(bytes32 paymentReference);
    error InsufficientReserve(uint256 requested, uint256 available);

    /// @notice ERC-20 FAsset this minter produces (FXRP).
    function fAsset() external view returns (address);

    /// @notice How many FAsset units `underlyingAmount` would produce right now.
    function previewMint(uint256 underlyingAmount) external view returns (uint256);

    /// @notice Convert an attested underlying payment into FAssets held by `recipient`.
    /// @param underlyingAmount Amount received on the underlying chain, in its base units.
    /// @param recipient        Address to receive the minted FAssets.
    /// @param proof            The same FDC Payment proof that {IntentSettler} verified.
    /// @return minted          FAsset units actually delivered to `recipient`.
    function mint(uint256 underlyingAmount, address recipient, IPayment.Proof calldata proof)
        external
        returns (uint256 minted);
}
