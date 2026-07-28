// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IFlareContractRegistry} from "./interfaces/IFlareContractRegistry.sol";
import {IFdcVerification} from "./interfaces/IFdcVerification.sol";
import {IPayment} from "./interfaces/IPayment.sol";
import {IFxrpMinter} from "./interfaces/IFxrpMinter.sol";
import {IIntentManager, Intent, IntentStatus, SourceChainConfig, TokenConfig} from
    "./interfaces/IIntentManager.sol";
import {PriceOracle} from "./PriceOracle.sol";
import {LiquidityPool} from "./LiquidityPool.sol";

/// @title  IntentSettler
/// @notice Turns a proven XRPL payment into the token the user asked for, in one transaction.
///
/// @dev    This is the trust boundary of FlareSwap. Everything it does is gated on a single
///         question — *did the Flare Data Connector attest to this exact payment?* — and the
///         answer comes from Flare's validator set, not from our relayer. Concretely,
///         {settleIntent} enforces, in order:
///
///           1. `FdcVerification.verifyPayment` — the Merkle proof resolves to a root that an
///              FDC voting round committed on-chain.
///           2. Attestation type is `Payment` and the source id matches the intent's chain, so a
///              proof from a different attestation type or a different chain cannot be replayed.
///           3. `status == 0` — the payment succeeded on the source chain.
///           4. `standardPaymentReference == intentId` — the XRPL memo binds the deposit to the
///              exact terms (min output, deadline, slippage) the user signed for.
///           5. `receivingAddressHash == config.depositAddressHash` — paid to *our* address.
///           6. `receivedAmount >= intent.sourceAmount` — no underpayment.
///           7. `transactionId` unseen — one XRPL payment can settle at most one intent, ever.
///
///         Only then does value move: mint FAssets, take the protocol fee, swap, and enforce
///         *both* the user's absolute `minOutputAmount` and an FTSO-derived slippage floor
///         before the output reaches them.
contract IntentSettler is Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @dev FDC attestation type ids are the ASCII name right-padded to 32 bytes.
    bytes32 public constant ATTESTATION_TYPE_PAYMENT = bytes32("Payment");
    uint8 public constant PAYMENT_STATUS_SUCCESS = 0;
    uint16 public constant MAX_PROTOCOL_FEE_BPS = 100; // 1.00%
    uint256 private constant BPS_DENOMINATOR = 10_000;

    address public constant CANONICAL_REGISTRY = 0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019;

    /* ------------------------------- wiring --------------------------------- */

    IIntentManager public immutable intentManager;
    PriceOracle public immutable priceOracle;
    IFlareContractRegistry public immutable registry;

    IFxrpMinter public minter;
    /// @notice Cached from `minter.fAsset()` on {setMinter}.
    IERC20 public fAsset;
    uint8 public fAssetDecimals;

    /// @notice Destination token => pool that trades it against the FAsset.
    mapping(address destinationToken => LiquidityPool) public poolFor;

    address public feeRecipient;
    uint16 public protocolFeeBps = 30; // 0.30%

    /// @notice When false, only whitelisted relayers may call {settleIntent}.
    /// @dev Defaults to true: settlement is safe for anyone to trigger because the FDC proof —
    ///      not the caller — is what authorises it, and the output can only go to `intent.user`.
    ///      The switch exists so an operator can fall back to a private relay if a griefing
    ///      pattern ever emerges.
    bool public permissionless = true;
    mapping(address account => bool) public isRelayer;

    /// @notice Source-chain transaction id => the intent it settled. The replay guard.
    mapping(bytes32 sourceTxId => bytes32 intentId) public settledByTx;

    uint256 public totalSettled;
    mapping(address token => uint256) public totalOutputDelivered;

    /* -------------------------------- events -------------------------------- */

    event IntentSettled(
        bytes32 indexed intentId,
        address indexed user,
        address indexed outputToken,
        uint256 sourceAmount,
        uint256 mintedAmount,
        uint256 outputAmount,
        uint256 protocolFee,
        bytes32 sourceTxId
    );
    event IntentExpired(bytes32 indexed intentId);
    event SettlementFailed(bytes32 indexed intentId, bytes reason);
    event MinterUpdated(address indexed previous, address indexed current, address fAsset);
    event PoolConfigured(address indexed destinationToken, address indexed pool);
    event ProtocolFeeUpdated(uint16 previous, uint16 current, address feeRecipient);
    event RelayerUpdated(address indexed relayer, bool allowed);
    event PermissionlessUpdated(bool permissionless);

    /* -------------------------------- errors -------------------------------- */

    error ZeroAddress();
    error NotRelayer(address caller);
    error MinterNotSet();
    error NoPoolForToken(address destinationToken);
    error IntentDeadlinePassed(bytes32 intentId, uint256 deadline);
    error InvalidProof(bytes32 intentId);
    error WrongAttestationType(bytes32 expected, bytes32 actual);
    error WrongSourceId(bytes32 expected, bytes32 actual);
    error PaymentNotSuccessful(uint8 status);
    error PaymentReferenceMismatch(bytes32 expected, bytes32 actual);
    error WrongReceivingAddress(bytes32 expected, bytes32 actual);
    error NonPositiveAmount(int256 receivedAmount);
    error DepositTooSmall(uint256 received, uint256 required);
    error ProofAlreadyUsed(bytes32 sourceTxId, bytes32 settledIntentId);
    error SourceChainDisabled(uint8 sourceChain);
    error DestinationTokenDisabled(address token);
    error NothingToSwap();
    error OutputBelowMinimum(uint256 outputAmount, uint256 minOutput);
    error SlippageExceeded(uint256 expectedOutput, uint256 actualOutput, uint16 maxSlippageBps);
    error ProtocolFeeTooHigh(uint16 bps, uint16 maxBps);
    error FdcVerificationNotRegistered();

    constructor(address intentManager_, address priceOracle_, address registry_, address owner_)
        Ownable(owner_)
    {
        if (intentManager_ == address(0) || priceOracle_ == address(0)) revert ZeroAddress();
        intentManager = IIntentManager(intentManager_);
        priceOracle = PriceOracle(priceOracle_);
        registry = IFlareContractRegistry(registry_ == address(0) ? CANONICAL_REGISTRY : registry_);
        feeRecipient = owner_;
    }

    /* ------------------------------------------------------------------ */
    /*                                admin                                */
    /* ------------------------------------------------------------------ */

    function setMinter(address newMinter) external onlyOwner {
        if (newMinter == address(0)) revert ZeroAddress();
        address previous = address(minter);
        minter = IFxrpMinter(newMinter);
        address fAsset_ = IFxrpMinter(newMinter).fAsset();
        if (fAsset_ == address(0)) revert ZeroAddress();
        fAsset = IERC20(fAsset_);
        fAssetDecimals = IERC20Metadata(fAsset_).decimals();
        emit MinterUpdated(previous, newMinter, fAsset_);
    }

    /// @notice Routes `destinationToken` through `pool`. Set `pool` to zero to remove the route.
    function setPool(address destinationToken, address pool) external onlyOwner {
        if (destinationToken == address(0)) revert ZeroAddress();
        poolFor[destinationToken] = LiquidityPool(pool);
        emit PoolConfigured(destinationToken, pool);
    }

    function setProtocolFee(uint16 newFeeBps, address newFeeRecipient) external onlyOwner {
        if (newFeeBps > MAX_PROTOCOL_FEE_BPS) revert ProtocolFeeTooHigh(newFeeBps, MAX_PROTOCOL_FEE_BPS);
        if (newFeeRecipient == address(0)) revert ZeroAddress();
        emit ProtocolFeeUpdated(protocolFeeBps, newFeeBps, newFeeRecipient);
        protocolFeeBps = newFeeBps;
        feeRecipient = newFeeRecipient;
    }

    function setRelayer(address relayer, bool allowed) external onlyOwner {
        if (relayer == address(0)) revert ZeroAddress();
        isRelayer[relayer] = allowed;
        emit RelayerUpdated(relayer, allowed);
    }

    function setPermissionless(bool value) external onlyOwner {
        permissionless = value;
        emit PermissionlessUpdated(value);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /* ------------------------------------------------------------------ */
    /*                             resolution                              */
    /* ------------------------------------------------------------------ */

    /// @notice Current FdcVerification address, resolved live from the Flare registry.
    function fdcVerification() public view returns (IFdcVerification) {
        address addr = registry.getContractAddressByName("FdcVerification");
        if (addr == address(0)) revert FdcVerificationNotRegistered();
        return IFdcVerification(addr);
    }

    /* ------------------------------------------------------------------ */
    /*                             settlement                              */
    /* ------------------------------------------------------------------ */

    /// @notice Settles `intentId` against an FDC-attested source-chain payment.
    /// @param proof The `Payment` attestation proof retrieved from a DA layer / FDC verifier.
    /// @return outputAmount Destination-token units delivered to `intent.user`.
    function settleIntent(bytes32 intentId, IPayment.Proof calldata proof)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 outputAmount)
    {
        // `address(this)` is allowed so {trySettleIntent} can wrap this call in try/catch.
        if (!permissionless && !isRelayer[msg.sender] && msg.sender != address(this)) {
            revert NotRelayer(msg.sender);
        }
        if (address(minter) == address(0)) revert MinterNotSet();

        // Flips the intent to `Settling`, which no other transition accepts as an input state.
        // That makes this a per-intent lock on top of the contract-wide `nonReentrant`.
        Intent memory intent = intentManager.lockForSettlement(intentId);
        if (block.timestamp > intent.deadline) revert IntentDeadlinePassed(intentId, intent.deadline);

        SourceChainConfig memory source = intentManager.getSourceChainConfig(intent.sourceChain);
        if (!source.enabled) revert SourceChainDisabled(intent.sourceChain);
        TokenConfig memory destination = intentManager.getTokenConfig(intent.destinationToken);
        if (!destination.enabled) revert DestinationTokenDisabled(intent.destinationToken);

        uint256 amountIn = _validateProof(intent, source, proof);

        (uint256 minted, uint256 fee, uint256 swapAmount) = _mintAndTakeFee(amountIn, proof);

        outputAmount = _deliver(intent, source, destination, swapAmount);

        intentManager.markSettled(intentId, outputAmount);
        totalSettled++;
        totalOutputDelivered[intent.destinationToken] += outputAmount;

        emit IntentSettled(
            intentId,
            intent.user,
            intent.destinationToken,
            amountIn,
            minted,
            outputAmount,
            fee,
            proof.data.requestBody.transactionId
        );
    }

    /// @notice Non-reverting wrapper so the relayer gets an on-chain audit trail of failures.
    /// @dev Emits {SettlementFailed} with the raw revert data instead of bubbling it. The inner
    ///      call reverts atomically, so a failed attempt leaves the intent exactly as it was.
    function trySettleIntent(bytes32 intentId, IPayment.Proof calldata proof)
        external
        returns (bool success, uint256 outputAmount)
    {
        try this.settleIntent(intentId, proof) returns (uint256 out) {
            return (true, out);
        } catch (bytes memory reason) {
            emit SettlementFailed(intentId, reason);
            return (false, 0);
        }
    }

    /// @notice Marks an intent expired once its deadline has passed. Callable by anyone.
    function expireIntent(bytes32 intentId) external {
        intentManager.markExpired(intentId);
        emit IntentExpired(intentId);
    }

    /* ------------------------------------------------------------------ */
    /*                          settlement steps                           */
    /* ------------------------------------------------------------------ */

    /// @dev Steps 1-7 of the trust boundary described in the contract docs. Writes the replay
    ///      guard, so it is non-view and must be called exactly once per settlement.
    function _validateProof(Intent memory intent, SourceChainConfig memory source, IPayment.Proof calldata proof)
        internal
        returns (uint256 amountIn)
    {
        if (!fdcVerification().verifyPayment(proof)) revert InvalidProof(intent.intentId);

        if (proof.data.attestationType != ATTESTATION_TYPE_PAYMENT) {
            revert WrongAttestationType(ATTESTATION_TYPE_PAYMENT, proof.data.attestationType);
        }
        if (proof.data.sourceId != source.sourceId) {
            revert WrongSourceId(source.sourceId, proof.data.sourceId);
        }

        IPayment.ResponseBody calldata body = proof.data.responseBody;
        if (body.status != PAYMENT_STATUS_SUCCESS) revert PaymentNotSuccessful(body.status);
        if (body.standardPaymentReference != intent.intentId) {
            revert PaymentReferenceMismatch(intent.intentId, body.standardPaymentReference);
        }
        if (body.receivingAddressHash != source.depositAddressHash) {
            revert WrongReceivingAddress(source.depositAddressHash, body.receivingAddressHash);
        }
        if (body.receivedAmount <= 0) revert NonPositiveAmount(body.receivedAmount);

        amountIn = uint256(body.receivedAmount);
        if (amountIn < intent.sourceAmount) revert DepositTooSmall(amountIn, intent.sourceAmount);

        bytes32 sourceTxId = proof.data.requestBody.transactionId;
        bytes32 alreadySettled = settledByTx[sourceTxId];
        if (alreadySettled != bytes32(0)) revert ProofAlreadyUsed(sourceTxId, alreadySettled);
        settledByTx[sourceTxId] = intent.intentId;
    }

    /// @dev Mints FAssets against the attested payment and skims the protocol fee off the top.
    function _mintAndTakeFee(uint256 amountIn, IPayment.Proof calldata proof)
        internal
        returns (uint256 minted, uint256 fee, uint256 swapAmount)
    {
        minted = minter.mint(amountIn, address(this), proof);
        if (minted == 0) revert NothingToSwap();

        fee = Math.mulDiv(minted, protocolFeeBps, BPS_DENOMINATOR);
        swapAmount = minted - fee;
        if (swapAmount == 0) revert NothingToSwap();

        if (fee > 0) fAsset.safeTransfer(feeRecipient, fee);
    }

    /// @dev Swaps into the destination token (or short-circuits when the user wants the FAsset
    ///      itself) and enforces both output bounds before the user is credited.
    function _deliver(
        Intent memory intent,
        SourceChainConfig memory source,
        TokenConfig memory destination,
        uint256 swapAmount
    ) internal returns (uint256 outputAmount) {
        // FTSO fair value for what we are about to trade. `swapAmount` is denominated in FAsset
        // units, and FXRP tracks XRP 1:1, so the source feed prices it directly.
        uint256 expectedOutput = priceOracle.getQuote(
            source.feedId, destination.feedId, swapAmount, fAssetDecimals, destination.decimals
        );

        if (intent.destinationToken == address(fAsset)) {
            // No swap needed — the user asked for FXRP itself.
            outputAmount = swapAmount;
            if (outputAmount < intent.minOutputAmount) {
                revert OutputBelowMinimum(outputAmount, intent.minOutputAmount);
            }
            fAsset.safeTransfer(intent.user, outputAmount);
            return outputAmount;
        }

        LiquidityPool pool = poolFor[intent.destinationToken];
        if (address(pool) == address(0)) revert NoPoolForToken(intent.destinationToken);

        // The binding floor is the *stricter* of what the user signed for and what the oracle
        // says is fair after slippage. The pool enforces it atomically inside `swap`.
        uint256 oracleFloor = priceOracle.slippageFloor(expectedOutput, intent.maxSlippageBps);
        uint256 minOut = Math.max(intent.minOutputAmount, oracleFloor);

        fAsset.forceApprove(address(pool), swapAmount);
        outputAmount = pool.swap(address(fAsset), swapAmount, minOut, intent.user, intent.deadline);
        // `swap` pulls exactly `swapAmount`; clear the allowance so none is left dangling.
        fAsset.forceApprove(address(pool), 0);

        if (outputAmount < intent.minOutputAmount) {
            revert OutputBelowMinimum(outputAmount, intent.minOutputAmount);
        }
        if (!priceOracle.isWithinSlippage(expectedOutput, outputAmount, intent.maxSlippageBps)) {
            revert SlippageExceeded(expectedOutput, outputAmount, intent.maxSlippageBps);
        }
    }

    /* ------------------------------------------------------------------ */
    /*                                views                                */
    /* ------------------------------------------------------------------ */

    /// @notice Full pre-trade quote for the frontend: oracle fair value, realised AMM output,
    ///         protocol fee and the resulting minimum the settler will accept.
    /// @param sourceChain     Source chain id as configured on {IntentManager}.
    /// @param sourceAmount    Deposit amount in source-chain base units (drops).
    /// @param destinationToken Token the user wants on Flare.
    /// @param maxSlippageBps  User's slippage tolerance.
    function quote(
        uint8 sourceChain,
        uint256 sourceAmount,
        address destinationToken,
        uint16 maxSlippageBps
    )
        external
        view
        returns (
            uint256 expectedOutput,
            uint256 ammOutput,
            uint256 minimumOutput,
            uint256 protocolFeeAmount,
            uint256 priceImpactBps
        )
    {
        SourceChainConfig memory source = intentManager.getSourceChainConfig(sourceChain);
        TokenConfig memory destination = intentManager.getTokenConfig(destinationToken);
        if (!source.enabled) revert SourceChainDisabled(sourceChain);
        if (!destination.enabled) revert DestinationTokenDisabled(destinationToken);
        if (address(minter) == address(0)) revert MinterNotSet();

        uint256 minted = minter.previewMint(sourceAmount);
        protocolFeeAmount = Math.mulDiv(minted, protocolFeeBps, BPS_DENOMINATOR);
        uint256 swapAmount = minted - protocolFeeAmount;

        expectedOutput = priceOracle.getQuote(
            source.feedId, destination.feedId, swapAmount, fAssetDecimals, destination.decimals
        );

        if (destinationToken == address(fAsset)) {
            ammOutput = swapAmount;
            minimumOutput = swapAmount;
            return (expectedOutput, ammOutput, minimumOutput, protocolFeeAmount, 0);
        }

        LiquidityPool pool = poolFor[destinationToken];
        if (address(pool) == address(0)) revert NoPoolForToken(destinationToken);

        ammOutput = pool.getAmountOut(address(fAsset), swapAmount);
        priceImpactBps = pool.priceImpactBps(address(fAsset), swapAmount);
        minimumOutput = priceOracle.slippageFloor(expectedOutput, maxSlippageBps);
    }

    /// @notice True when this exact source-chain transaction has already settled an intent.
    function isProofSpent(bytes32 sourceTxId) external view returns (bool) {
        return settledByTx[sourceTxId] != bytes32(0);
    }
}
