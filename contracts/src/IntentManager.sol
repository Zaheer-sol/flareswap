// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {
    IIntentManager,
    Intent,
    IntentStatus,
    SourceChainConfig,
    TokenConfig
} from "./interfaces/IIntentManager.sol";

/// @title  IntentManager
/// @notice The entry point of FlareSwap: users register *what they want* here, then pay on the
///         source chain. Nothing in this contract moves value — it is the canonical, on-chain
///         record of intent and its lifecycle, which {IntentSettler} advances once the Flare
///         Data Connector has proved the source-chain deposit.
///
/// @dev    Why intents live on-chain at all:
///           * the `intentId` doubles as the XRPL payment reference, so the deposit is
///             cryptographically bound to the terms the user signed for,
///           * `minOutputAmount` / `deadline` / `maxSlippageBps` are committed *before* the
///             deposit, so a relayer cannot settle on worse terms than the user accepted,
///           * anyone can audit the full order book without trusting our backend.
contract IntentManager is IIntentManager, Ownable2Step, Pausable {
    uint16 public constant MAX_SLIPPAGE_BPS = 5_000; // 50%
    uint256 public constant MIN_DEADLINE_WINDOW = 5 minutes;
    uint256 public constant MAX_DEADLINE_WINDOW = 7 days;

    /// @notice XRPL destination tags are uint32. Start well above anything a human types.
    uint32 public constant FIRST_DESTINATION_TAG = 1_000_000;

    /* ------------------------------- storage -------------------------------- */

    mapping(bytes32 intentId => Intent) private _intents;
    mapping(address user => bytes32[]) private _userIntents;
    mapping(address user => uint256) public nonces;

    mapping(uint8 sourceChain => SourceChainConfig) private _sourceChains;
    mapping(address token => TokenConfig) private _tokens;

    /// @notice Contracts allowed to advance intent lifecycle (the settler, the relayer).
    mapping(address account => bool) public authorized;

    /// @notice Maps an XRPL destination tag back to the intent that owns it.
    mapping(uint32 destinationTag => bytes32 intentId) public intentByDestinationTag;

    uint32 public nextDestinationTag = FIRST_DESTINATION_TAG;
    uint256 public totalIntents;

    /// @notice Per-source-chain deposit bounds, in the source chain's base units.
    mapping(uint8 sourceChain => uint256) public minSourceAmount;
    mapping(uint8 sourceChain => uint256) public maxSourceAmount;

    /* ------------------------------ modifiers ------------------------------- */

    modifier onlyAuthorized() {
        if (!authorized[msg.sender]) revert NotAuthorized(msg.sender);
        _;
    }

    constructor(address owner_) Ownable(owner_) {
        if (owner_ == address(0)) revert ZeroAddress();
    }

    /* ------------------------------------------------------------------ */
    /*                            configuration                            */
    /* ------------------------------------------------------------------ */

    function setAuthorized(address account, bool isAuthorized) external onlyOwner {
        if (account == address(0)) revert ZeroAddress();
        authorized[account] = isAuthorized;
        emit AuthorizationChanged(account, isAuthorized);
    }

    function configureSourceChain(
        uint8 sourceChain,
        SourceChainConfig calldata config,
        uint256 minAmount,
        uint256 maxAmount
    ) external onlyOwner {
        require(maxAmount >= minAmount, "IntentManager: bad amount range");
        _sourceChains[sourceChain] = config;
        minSourceAmount[sourceChain] = minAmount;
        maxSourceAmount[sourceChain] = maxAmount;
        emit SourceChainConfigured(sourceChain, config.name, config.depositAddress);
    }

    function configureToken(address token, TokenConfig calldata config) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        _tokens[token] = config;
        emit TokenConfigured(token, config.symbol, config.enabled);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /* ------------------------------------------------------------------ */
    /*                             user actions                            */
    /* ------------------------------------------------------------------ */

    /// @inheritdoc IIntentManager
    /// @dev Returns the deposit address and destination tag so a single `eth_call` simulation
    ///      gives the frontend everything it needs to render the XRPL payment instructions.
    function createIntent(
        uint8 sourceChain,
        uint256 sourceAmount,
        address destinationToken,
        uint256 minOutputAmount,
        uint256 deadline,
        uint16 maxSlippageBps
    )
        external
        whenNotPaused
        returns (bytes32 intentId, string memory depositAddress, uint32 destinationTag)
    {
        SourceChainConfig storage source = _sourceChains[sourceChain];
        if (!source.enabled) revert SourceChainDisabled(sourceChain);
        if (!_tokens[destinationToken].enabled) revert TokenDisabled(destinationToken);

        uint256 minAmount = minSourceAmount[sourceChain];
        uint256 maxAmount = maxSourceAmount[sourceChain];
        if (sourceAmount < minAmount || sourceAmount > maxAmount) {
            revert AmountOutOfRange(sourceAmount, minAmount, maxAmount);
        }
        if (maxSlippageBps > MAX_SLIPPAGE_BPS) revert SlippageTooHigh(maxSlippageBps, MAX_SLIPPAGE_BPS);
        if (deadline < block.timestamp + MIN_DEADLINE_WINDOW) revert DeadlineInPast(deadline);
        if (deadline > block.timestamp + MAX_DEADLINE_WINDOW) {
            revert DeadlineTooFar(deadline, block.timestamp + MAX_DEADLINE_WINDOW);
        }

        uint256 nonce = nonces[msg.sender]++;
        // Domain-separated so an id can never be replayed on another chain or deployment.
        intentId = keccak256(abi.encode(block.chainid, address(this), msg.sender, nonce));

        destinationTag = nextDestinationTag++;
        depositAddress = source.depositAddress;

        _intents[intentId] = Intent({
            intentId: intentId,
            user: msg.sender,
            sourceChain: sourceChain,
            sourceToken: source.symbol,
            sourceAmount: sourceAmount,
            destinationToken: destinationToken,
            minOutputAmount: minOutputAmount,
            deadline: deadline,
            xrplDestinationTag: destinationTag,
            maxSlippageBps: maxSlippageBps,
            status: IntentStatus.Pending,
            createdAt: uint64(block.timestamp),
            settledAt: 0,
            outputAmount: 0
        });

        _userIntents[msg.sender].push(intentId);
        intentByDestinationTag[destinationTag] = intentId;
        totalIntents++;

        emit IntentCreated(
            intentId,
            msg.sender,
            sourceChain,
            sourceAmount,
            destinationToken,
            minOutputAmount,
            deadline,
            destinationTag
        );
    }

    /// @inheritdoc IIntentManager
    /// @dev Only allowed while `Pending`. Once a deposit has been observed the funds are already
    ///      in flight on the source chain, so cancelling would strand them — such an intent must
    ///      run to `Settled` or `Expired` (and be refunded off-chain) instead.
    function cancelIntent(bytes32 intentId) external {
        Intent storage intent = _requireIntent(intentId);
        if (intent.user != msg.sender) revert NotIntentOwner(intentId, msg.sender);
        if (intent.status != IntentStatus.Pending) {
            revert InvalidStatus(intentId, intent.status, IntentStatus.Pending);
        }

        _setStatus(intent, IntentStatus.Cancelled);
        emit IntentCancelled(intentId, msg.sender);
    }

    /* ------------------------------------------------------------------ */
    /*                     authorized lifecycle hooks                      */
    /* ------------------------------------------------------------------ */

    /// @inheritdoc IIntentManager
    function markDeposited(bytes32 intentId, bytes32 sourceTxId) external onlyAuthorized {
        Intent storage intent = _requireIntent(intentId);
        if (intent.status != IntentStatus.Pending) {
            revert InvalidStatus(intentId, intent.status, IntentStatus.Pending);
        }
        _setStatus(intent, IntentStatus.Deposited);
        emit IntentDeposited(intentId, sourceTxId);
    }

    /// @inheritdoc IIntentManager
    /// @dev Moves the intent into `Settling` and returns a snapshot. Because `Settling` is not a
    ///      valid input state for any other transition, this is a per-intent re-entrancy lock:
    ///      a malicious token or pool that calls back into `settleIntent` for the same id will
    ///      fail this check.
    function lockForSettlement(bytes32 intentId) external onlyAuthorized returns (Intent memory) {
        Intent storage intent = _requireIntent(intentId);
        if (intent.status != IntentStatus.Pending && intent.status != IntentStatus.Deposited) {
            revert InvalidStatus(intentId, intent.status, IntentStatus.Deposited);
        }
        _setStatus(intent, IntentStatus.Settling);
        return intent;
    }

    /// @inheritdoc IIntentManager
    function markSettled(bytes32 intentId, uint256 outputAmount) external onlyAuthorized {
        Intent storage intent = _requireIntent(intentId);
        if (intent.status != IntentStatus.Settling) {
            revert InvalidStatus(intentId, intent.status, IntentStatus.Settling);
        }
        intent.outputAmount = outputAmount;
        intent.settledAt = uint64(block.timestamp);
        _setStatus(intent, IntentStatus.Settled);
        emit IntentSettledRecorded(intentId, outputAmount);
    }

    /// @inheritdoc IIntentManager
    /// @dev Releases the settlement lock without settling — used by {IntentSettler} only in
    ///      flows that abandon a settlement attempt deliberately.
    function unlock(bytes32 intentId) external onlyAuthorized {
        Intent storage intent = _requireIntent(intentId);
        if (intent.status != IntentStatus.Settling) {
            revert InvalidStatus(intentId, intent.status, IntentStatus.Settling);
        }
        _setStatus(intent, IntentStatus.Deposited);
    }

    /// @inheritdoc IIntentManager
    function markExpired(bytes32 intentId) external onlyAuthorized {
        Intent storage intent = _requireIntent(intentId);
        if (intent.status != IntentStatus.Pending && intent.status != IntentStatus.Deposited) {
            revert InvalidStatus(intentId, intent.status, IntentStatus.Pending);
        }
        if (block.timestamp <= intent.deadline) revert IntentNotExpired(intentId, intent.deadline);
        _setStatus(intent, IntentStatus.Expired);
    }

    /* ------------------------------------------------------------------ */
    /*                                views                                */
    /* ------------------------------------------------------------------ */

    function getIntent(bytes32 intentId) external view returns (Intent memory) {
        return _intents[intentId];
    }

    function getUserIntents(address user) external view returns (bytes32[] memory) {
        return _userIntents[user];
    }

    function getUserIntentCount(address user) external view returns (uint256) {
        return _userIntents[user].length;
    }

    /// @notice Paginated variant of {getUserIntents} for users with long histories.
    function getUserIntentsPaged(address user, uint256 offset, uint256 limit)
        external
        view
        returns (bytes32[] memory page)
    {
        bytes32[] storage all = _userIntents[user];
        if (offset >= all.length) return new bytes32[](0);
        uint256 end = offset + limit;
        if (end > all.length) end = all.length;
        page = new bytes32[](end - offset);
        for (uint256 i = offset; i < end; i++) {
            page[i - offset] = all[i];
        }
    }

    function getSourceChainConfig(uint8 sourceChain) external view returns (SourceChainConfig memory) {
        return _sourceChains[sourceChain];
    }

    function getTokenConfig(address token) external view returns (TokenConfig memory) {
        return _tokens[token];
    }

    /// @notice True when `intentId` is past its deadline and still awaiting settlement.
    function isExpirable(bytes32 intentId) external view returns (bool) {
        Intent storage intent = _intents[intentId];
        return (intent.status == IntentStatus.Pending || intent.status == IntentStatus.Deposited)
            && block.timestamp > intent.deadline;
    }

    /* ------------------------------------------------------------------ */
    /*                              internals                              */
    /* ------------------------------------------------------------------ */

    function _requireIntent(bytes32 intentId) private view returns (Intent storage intent) {
        intent = _intents[intentId];
        if (intent.status == IntentStatus.None) revert UnknownIntent(intentId);
    }

    function _setStatus(Intent storage intent, IntentStatus next) private {
        IntentStatus previous = intent.status;
        intent.status = next;
        emit IntentStatusChanged(intent.intentId, previous, next);
    }
}
