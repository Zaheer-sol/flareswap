// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

/// @notice Lifecycle of a cross-chain swap intent.
enum IntentStatus {
    None, // 0 - intent id was never created
    Pending, // 1 - created on Flare, waiting for the source-chain deposit
    Deposited, // 2 - deposit observed on the source chain, FDC attestation in flight
    Settling, // 3 - re-entrancy lock held by IntentSettler for the duration of settlement
    Settled, // 4 - output token delivered to the user
    Expired, // 5 - deadline passed without a valid deposit
    Cancelled // 6 - cancelled by the user before any deposit was observed

}

/// @notice A user's cross-chain swap request.
/// @dev `sourceAmount` is denominated in the source chain's smallest unit (drops for XRP,
///      satoshi for BTC). `minOutputAmount` is in `destinationToken`'s own decimals.
struct Intent {
    bytes32 intentId;
    address user;
    uint8 sourceChain;
    string sourceToken;
    uint256 sourceAmount;
    address destinationToken;
    uint256 minOutputAmount;
    uint256 deadline;
    uint32 xrplDestinationTag;
    uint16 maxSlippageBps;
    IntentStatus status;
    uint64 createdAt;
    uint64 settledAt;
    uint256 outputAmount;
}

/// @notice Per-source-chain configuration (deposit address, FTSO feed, decimals).
struct SourceChainConfig {
    bool enabled;
    uint8 decimals; // 6 for XRP (drops), 8 for BTC (satoshi)
    bytes21 feedId; // FTSOv2 feed id for <asset>/USD
    bytes32 sourceId; // FDC source id, e.g. bytes32("testXRP")
    bytes32 depositAddressHash; // keccak256 of the standardised deposit address string
    string name; // "XRPL"
    string symbol; // "XRP"
    string depositAddress; // human-readable address the user must pay
}

/// @notice Per-destination-token configuration.
struct TokenConfig {
    bool enabled;
    uint8 decimals;
    bytes21 feedId; // FTSOv2 feed id for <token>/USD
    string symbol;
}

interface IIntentManager {
    /* ----------------------------------- events ----------------------------------- */

    event IntentCreated(
        bytes32 indexed intentId,
        address indexed user,
        uint8 indexed sourceChain,
        uint256 sourceAmount,
        address destinationToken,
        uint256 minOutputAmount,
        uint256 deadline,
        uint32 xrplDestinationTag
    );
    event IntentCancelled(bytes32 indexed intentId, address indexed user);
    event IntentDeposited(bytes32 indexed intentId, bytes32 sourceTxId);
    event IntentStatusChanged(bytes32 indexed intentId, IntentStatus previous, IntentStatus current);
    event IntentSettledRecorded(bytes32 indexed intentId, uint256 outputAmount);
    event SourceChainConfigured(uint8 indexed sourceChain, string name, string depositAddress);
    event TokenConfigured(address indexed token, string symbol, bool enabled);
    event AuthorizationChanged(address indexed account, bool authorized);

    /* ----------------------------------- errors ----------------------------------- */

    error NotAuthorized(address caller);
    error UnknownIntent(bytes32 intentId);
    error NotIntentOwner(bytes32 intentId, address caller);
    error InvalidStatus(bytes32 intentId, IntentStatus actual, IntentStatus expected);
    error SourceChainDisabled(uint8 sourceChain);
    error TokenDisabled(address token);
    error DeadlineInPast(uint256 deadline);
    error DeadlineTooFar(uint256 deadline, uint256 maxDeadline);
    error AmountOutOfRange(uint256 amount, uint256 min, uint256 max);
    error SlippageTooHigh(uint16 bps, uint16 maxBps);
    error IntentNotExpired(bytes32 intentId, uint256 deadline);
    error ZeroAddress();

    /* ---------------------------------- functions --------------------------------- */

    function createIntent(
        uint8 sourceChain,
        uint256 sourceAmount,
        address destinationToken,
        uint256 minOutputAmount,
        uint256 deadline,
        uint16 maxSlippageBps
    ) external returns (bytes32 intentId, string memory depositAddress, uint32 destinationTag);

    function cancelIntent(bytes32 intentId) external;

    function getIntent(bytes32 intentId) external view returns (Intent memory);

    function getUserIntents(address user) external view returns (bytes32[] memory);

    function getSourceChainConfig(uint8 sourceChain) external view returns (SourceChainConfig memory);

    function getTokenConfig(address token) external view returns (TokenConfig memory);

    /* ------------------------- authorized lifecycle hooks -------------------------- */

    function markDeposited(bytes32 intentId, bytes32 sourceTxId) external;

    function lockForSettlement(bytes32 intentId) external returns (Intent memory);

    function markSettled(bytes32 intentId, uint256 outputAmount) external;

    function unlock(bytes32 intentId) external;

    function markExpired(bytes32 intentId) external;
}
