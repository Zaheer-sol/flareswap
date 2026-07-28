// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {IPayment} from "./IPayment.sol";

/// @notice Minimal FAssets v1.3 AssetManager surface used by {FAssetsMinter}.
/// @dev Only the members FlareSwap actually calls are declared. The full interface lives in
///      `fasset/contracts/userInterfaces/IAssetManager.sol`.
interface IAssetManager {
    /// @notice The ERC-20 FAsset minted by this manager (FXRP, FBTC, FDOGE, ...).
    function fAsset() external view returns (address);

    /// @notice Smallest indivisible unit of the underlying asset, in FAsset wei (1 drop for XRP).
    function assetMintingGranularityUBA() external view returns (uint256);

    /// @notice Number of decimals of the underlying chain's asset (6 for XRP).
    function assetMintingDecimals() external view returns (uint256);

    /// @notice Reserve minting capacity against an agent's collateral.
    /// @dev Must be called with `msg.value >= collateralReservationFee(_lots)`.
    /// @return _collateralReservationId Id to pass to {executeMinting}.
    function reserveCollateral(
        address _agentVault,
        uint256 _lots,
        uint256 _maxMintingFeeBIPS,
        address payable _executor,
        string[] calldata _minterUnderlyingAddresses
    ) external payable returns (uint256 _collateralReservationId);

    /// @notice Native-token fee required to reserve `_lots` lots.
    function collateralReservationFee(uint256 _lots) external view returns (uint256);

    /// @notice Finalise a minting after the underlying payment has been attested by the FDC.
    /// @dev Mints FAssets to the minter recorded in the collateral reservation.
    function executeMinting(IPayment.Proof calldata _payment, uint256 _collateralReservationId) external;

    /// @notice Size of one lot, in underlying base units (drops).
    function lotSize() external view returns (uint256);
}
