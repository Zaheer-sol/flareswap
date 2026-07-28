// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IFxrpMinter} from "../interfaces/IFxrpMinter.sol";
import {IPayment} from "../interfaces/IPayment.sol";

/// @title  PooledFxrpMinter
/// @notice Testnet / demo implementation of {IFxrpMinter}: releases pre-minted FXRP from a
///         reserve instead of driving a live FAssets collateral reservation.
///
/// @dev    Why this exists: FAssets minting requires an agent with free collateral to have
///         reserved lots *before* the user pays, and lot sizes are coarse. That is the right
///         production flow ({FAssetsMinter} implements it), but it makes a scripted demo depend
///         on third-party agent availability. This adapter keeps the exact same interface and
///         the exact same trust boundary — it is only ever reachable *after* {IntentSettler}
///         has verified a real FDC proof of a real XRPL payment — while sourcing the FXRP from
///         a reserve the operator topped up in advance.
///
///         The economics are identical: XRP arrives at the deposit address, an equal amount of
///         FXRP leaves this reserve. Swapping this contract for {FAssetsMinter} changes nothing
///         upstream.
contract PooledFxrpMinter is IFxrpMinter, Ownable2Step {
    using SafeERC20 for IERC20;

    IERC20 public immutable fxrp;

    /// @notice Decimals of the underlying asset on its native chain (6 for XRP drops).
    uint8 public immutable underlyingDecimals;
    /// @notice Decimals of the FAsset ERC-20 on Flare (6 for FXRP).
    uint8 public immutable fAssetDecimals;

    /// @notice Addresses permitted to call {mint} — in practice only {IntentSettler}.
    mapping(address account => bool) public authorized;

    /// @notice Running total of FXRP released, for reserve accounting.
    uint256 public totalMinted;

    event AuthorizationChanged(address indexed account, bool authorized);
    event ReserveFunded(address indexed from, uint256 amount);
    event ReserveWithdrawn(address indexed to, uint256 amount);
    event Minted(bytes32 indexed paymentReference, address indexed recipient, uint256 amount);

    error ZeroAddress();

    modifier onlyAuthorized() {
        if (!authorized[msg.sender]) revert MinterNotAuthorized(msg.sender);
        _;
    }

    constructor(address fxrp_, uint8 underlyingDecimals_, address owner_) Ownable(owner_) {
        if (fxrp_ == address(0)) revert ZeroAddress();
        fxrp = IERC20(fxrp_);
        underlyingDecimals = underlyingDecimals_;
        fAssetDecimals = IERC20Metadata(fxrp_).decimals();
    }

    /* ------------------------------------------------------------------ */
    /*                                admin                                */
    /* ------------------------------------------------------------------ */

    function setAuthorized(address account, bool isAuthorized) external onlyOwner {
        if (account == address(0)) revert ZeroAddress();
        authorized[account] = isAuthorized;
        emit AuthorizationChanged(account, isAuthorized);
    }

    /// @notice Tops up the FXRP reserve this adapter draws from.
    function fundReserve(uint256 amount) external {
        fxrp.safeTransferFrom(msg.sender, address(this), amount);
        emit ReserveFunded(msg.sender, amount);
    }

    function withdrawReserve(address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        fxrp.safeTransfer(to, amount);
        emit ReserveWithdrawn(to, amount);
    }

    /* ------------------------------------------------------------------ */
    /*                              IFxrpMinter                            */
    /* ------------------------------------------------------------------ */

    function fAsset() external view returns (address) {
        return address(fxrp);
    }

    function reserveBalance() public view returns (uint256) {
        return fxrp.balanceOf(address(this));
    }

    /// @inheritdoc IFxrpMinter
    function previewMint(uint256 underlyingAmount) public view returns (uint256) {
        return _scale(underlyingAmount);
    }

    /// @inheritdoc IFxrpMinter
    function mint(uint256 underlyingAmount, address recipient, IPayment.Proof calldata proof)
        external
        onlyAuthorized
        returns (uint256 minted)
    {
        if (recipient == address(0)) revert ZeroAddress();
        minted = _scale(underlyingAmount);

        uint256 available = reserveBalance();
        if (minted > available) revert InsufficientReserve(minted, available);
        if (minted == 0) revert MintFailed(proof.data.responseBody.standardPaymentReference);

        totalMinted += minted;
        fxrp.safeTransfer(recipient, minted);
        emit Minted(proof.data.responseBody.standardPaymentReference, recipient, minted);
    }

    /// @dev 1:1 in whole units, rescaled if the FAsset and the underlying disagree on decimals.
    function _scale(uint256 underlyingAmount) private view returns (uint256) {
        if (fAssetDecimals == underlyingDecimals) return underlyingAmount;
        if (fAssetDecimals > underlyingDecimals) {
            return underlyingAmount * (10 ** (fAssetDecimals - underlyingDecimals));
        }
        return underlyingAmount / (10 ** (underlyingDecimals - fAssetDecimals));
    }
}
