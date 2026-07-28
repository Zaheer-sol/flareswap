// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IFxrpMinter} from "../interfaces/IFxrpMinter.sol";
import {IAssetManager} from "../interfaces/IAssetManager.sol";
import {IPayment} from "../interfaces/IPayment.sol";

/// @title  FAssetsMinter
/// @notice Production implementation of {IFxrpMinter}: drives a real FAssets v1.3 minting.
///
/// @dev    FAssets minting is a two-phase protocol and this contract owns both halves:
///
///         1. **Reserve** — before the user pays, an operator calls {reserveCollateral} here.
///            This contract becomes the *minter of record* on the AssetManager and locks an
///            agent's collateral for `lots` lots. The reservation is filed under the intent's
///            payment reference, which is exactly what the user will put in their XRPL memo.
///
///         2. **Execute** — after the FDC attests the XRPL payment, {IntentSettler} calls
///            {mint} with the same proof it just verified. We look up the reservation by the
///            proof's payment reference and call `executeMinting`, which mints FXRP to this
///            contract. We measure the balance delta and forward it to `recipient`.
///
///         Measuring the delta rather than trusting a return value means an agent's minting fee,
///         or any future change to how the AssetManager splits the mint, is accounted for
///         correctly — {IntentSettler} then swaps whatever actually arrived.
contract FAssetsMinter is IFxrpMinter, Ownable2Step {
    using SafeERC20 for IERC20;

    IAssetManager public immutable assetManager;
    IERC20 public immutable fxrp;
    uint8 public immutable underlyingDecimals;
    uint8 public immutable fAssetDecimals;

    /// @notice paymentReference => AssetManager collateral reservation id.
    mapping(bytes32 paymentReference => uint256 collateralReservationId) public reservationFor;

    /// @notice Addresses permitted to call {mint} ({IntentSettler}) and {reserveCollateral}
    ///         (the relayer's operator key).
    mapping(address account => bool) public authorized;

    uint256 public totalMinted;

    event AuthorizationChanged(address indexed account, bool authorized);
    event CollateralReserved(
        bytes32 indexed paymentReference, uint256 indexed collateralReservationId, address agentVault
    );
    event ReservationCleared(bytes32 indexed paymentReference, uint256 collateralReservationId);
    event Minted(bytes32 indexed paymentReference, address indexed recipient, uint256 amount);

    error ZeroAddress();
    error NoReservation(bytes32 paymentReference);
    error ReservationExists(bytes32 paymentReference, uint256 collateralReservationId);

    modifier onlyAuthorized() {
        if (!authorized[msg.sender]) revert MinterNotAuthorized(msg.sender);
        _;
    }

    constructor(address assetManager_, uint8 underlyingDecimals_, address owner_) Ownable(owner_) {
        if (assetManager_ == address(0)) revert ZeroAddress();
        assetManager = IAssetManager(assetManager_);
        address fAsset_ = IAssetManager(assetManager_).fAsset();
        if (fAsset_ == address(0)) revert ZeroAddress();
        fxrp = IERC20(fAsset_);
        underlyingDecimals = underlyingDecimals_;
        fAssetDecimals = IERC20Metadata(fAsset_).decimals();
    }

    receive() external payable {}

    /* ------------------------------------------------------------------ */
    /*                                admin                                */
    /* ------------------------------------------------------------------ */

    function setAuthorized(address account, bool isAuthorized) external onlyOwner {
        if (account == address(0)) revert ZeroAddress();
        authorized[account] = isAuthorized;
        emit AuthorizationChanged(account, isAuthorized);
    }

    function withdrawNative(address payable to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        (bool ok,) = to.call{value: amount}("");
        require(ok, "FAssetsMinter: native transfer failed");
    }

    /// @notice Clears a stale reservation so the reference can be re-reserved after a timeout.
    function clearReservation(bytes32 paymentReference) external onlyAuthorized {
        uint256 crId = reservationFor[paymentReference];
        delete reservationFor[paymentReference];
        emit ReservationCleared(paymentReference, crId);
    }

    /* ------------------------------------------------------------------ */
    /*                          phase 1: reserve                           */
    /* ------------------------------------------------------------------ */

    /// @notice Locks agent collateral for an intent that has not been paid yet.
    /// @dev Must be sent `assetManager.collateralReservationFee(lots)` in native FLR.
    /// @param paymentReference The intent id the user will quote in their XRPL memo.
    function reserveCollateral(
        bytes32 paymentReference,
        address agentVault,
        uint256 lots,
        uint256 maxMintingFeeBIPS,
        string[] calldata minterUnderlyingAddresses
    ) external payable onlyAuthorized returns (uint256 collateralReservationId) {
        uint256 existing = reservationFor[paymentReference];
        if (existing != 0) revert ReservationExists(paymentReference, existing);

        collateralReservationId = assetManager.reserveCollateral{value: msg.value}(
            agentVault, lots, maxMintingFeeBIPS, payable(address(this)), minterUnderlyingAddresses
        );
        reservationFor[paymentReference] = collateralReservationId;
        emit CollateralReserved(paymentReference, collateralReservationId, agentVault);
    }

    /// @notice Underlying base units per lot, useful for sizing `lots` off-chain.
    function lotSize() external view returns (uint256) {
        return assetManager.lotSize();
    }

    function collateralReservationFee(uint256 lots) external view returns (uint256) {
        return assetManager.collateralReservationFee(lots);
    }

    /* ------------------------------------------------------------------ */
    /*                      phase 2: IFxrpMinter                           */
    /* ------------------------------------------------------------------ */

    function fAsset() external view returns (address) {
        return address(fxrp);
    }

    /// @inheritdoc IFxrpMinter
    /// @dev Best-effort: the true amount depends on the agent's minting fee, so callers should
    ///      treat this as an upper bound and rely on the measured delta from {mint}.
    function previewMint(uint256 underlyingAmount) external view returns (uint256) {
        if (fAssetDecimals == underlyingDecimals) return underlyingAmount;
        if (fAssetDecimals > underlyingDecimals) {
            return underlyingAmount * (10 ** (fAssetDecimals - underlyingDecimals));
        }
        return underlyingAmount / (10 ** (underlyingDecimals - fAssetDecimals));
    }

    /// @inheritdoc IFxrpMinter
    function mint(uint256, /* underlyingAmount */ address recipient, IPayment.Proof calldata proof)
        external
        onlyAuthorized
        returns (uint256 minted)
    {
        if (recipient == address(0)) revert ZeroAddress();

        bytes32 paymentReference = proof.data.responseBody.standardPaymentReference;
        uint256 crId = reservationFor[paymentReference];
        if (crId == 0) revert NoReservation(paymentReference);

        // Clear before the external call: `executeMinting` reverts on a spent reservation, but
        // clearing first also makes double-execution impossible from our side.
        delete reservationFor[paymentReference];

        uint256 balanceBefore = fxrp.balanceOf(address(this));
        assetManager.executeMinting(proof, crId);
        minted = fxrp.balanceOf(address(this)) - balanceBefore;
        if (minted == 0) revert MintFailed(paymentReference);

        totalMinted += minted;
        fxrp.safeTransfer(recipient, minted);
        emit Minted(paymentReference, recipient, minted);
    }
}
