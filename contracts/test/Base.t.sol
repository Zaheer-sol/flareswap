// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {Test} from "forge-std/Test.sol";

import {IntentManager} from "../src/IntentManager.sol";
import {IntentSettler} from "../src/IntentSettler.sol";
import {PriceOracle} from "../src/PriceOracle.sol";
import {LiquidityPool} from "../src/LiquidityPool.sol";
import {PooledFxrpMinter} from "../src/adapters/PooledFxrpMinter.sol";
import {FeedIds} from "../src/libraries/FeedIds.sol";
import {IPayment} from "../src/interfaces/IPayment.sol";
import {SourceChainConfig, TokenConfig, Intent, IntentStatus} from "../src/interfaces/IIntentManager.sol";

import {MockERC20} from "../src/mocks/MockERC20.sol";
import {MockFtsoV2} from "../src/mocks/MockFtsoV2.sol";
import {MockFdcVerification} from "../src/mocks/MockFdcVerification.sol";
import {MockFlareContractRegistry} from "../src/mocks/MockFlareContractRegistry.sol";

/// @notice Shared fixture: a fully wired FlareSwap deployment on top of mocked Flare protocols.
/// @dev The FDC mock performs real Merkle verification, so proofs built here go through the same
///      leaf construction and root check as mainnet. {commit} publishes a single-leaf root;
///      {commitWithSibling} publishes a two-leaf tree so the sibling-hashing path is covered too.
abstract contract BaseTest is Test {
    /* ------------------------------- actors --------------------------------- */

    address internal owner = makeAddr("owner");
    address internal user = makeAddr("user");
    address internal relayer = makeAddr("relayer");
    address internal lp = makeAddr("lp");
    address internal feeRecipient = makeAddr("feeRecipient");
    address internal attacker = makeAddr("attacker");

    /* ---------------------------- flare mocks ------------------------------- */

    MockFlareContractRegistry internal registry;
    MockFtsoV2 internal ftso;
    MockFdcVerification internal fdc;

    /* -------------------------------- tokens -------------------------------- */

    MockERC20 internal fxrp;
    MockERC20 internal usdc;

    /* -------------------------------- system -------------------------------- */

    IntentManager internal manager;
    PriceOracle internal oracle;
    LiquidityPool internal pool;
    PooledFxrpMinter internal minter;
    IntentSettler internal settler;

    /* ------------------------------ constants ------------------------------- */

    uint8 internal constant CHAIN_XRPL = 0;
    uint8 internal constant CHAIN_BTC = 1;
    uint8 internal constant XRP_DECIMALS = 6;

    string internal constant XRPL_DEPOSIT_ADDRESS = "rFLARESWAPcoreVaultDeposit1234567";
    bytes32 internal constant XRPL_SOURCE_ID = bytes32("testXRP");
    uint64 internal constant VOTING_ROUND = 123_456;

    /// @dev XRP/USD = 0.62480, reported with 5 decimals like the live FTSO feed.
    uint256 internal constant XRP_PRICE = 62_480;
    /// @dev USDC/USD = 1.00000.
    uint256 internal constant USDC_PRICE = 100_000;
    int8 internal constant PRICE_DECIMALS = 5;

    /// @dev Pool seeded at exactly the oracle rate: 1,000,000 FXRP / 624,800 USDC.
    uint256 internal constant POOL_FXRP = 1_000_000e6;
    uint256 internal constant POOL_USDC = 624_800e6;

    uint256 internal constant MIN_DEPOSIT = 1e6; // 1 XRP
    uint256 internal constant MAX_DEPOSIT = 5_000_000e6; // 5M XRP

    uint256 internal constant START_TIME = 1_800_000_000;

    function setUp() public virtual {
        vm.warp(START_TIME);

        _deployFlareMocks();
        _deployTokens();
        _deployProtocol();
        _configure();
        _seedLiquidity();
        _fundMinterReserve(2_000_000e6);
    }

    /* ------------------------------------------------------------------ */
    /*                               deploy                                */
    /* ------------------------------------------------------------------ */

    function _deployFlareMocks() internal {
        registry = new MockFlareContractRegistry();
        ftso = new MockFtsoV2();
        fdc = new MockFdcVerification();

        registry.setContractAddress("FtsoV2", address(ftso));
        registry.setContractAddress("FdcVerification", address(fdc));

        refreshPrices();
    }

    function _deployTokens() internal {
        fxrp = new MockERC20("FAsset XRP", "FXRP", 6);
        usdc = new MockERC20("USD Coin", "USDC", 6);
    }

    function _deployProtocol() internal {
        manager = new IntentManager(owner);
        oracle = new PriceOracle(address(registry), owner);
        pool = new LiquidityPool(address(fxrp), address(usdc), owner, "FlareSwap FXRP/USDC LP", "FSLP");
        minter = new PooledFxrpMinter(address(fxrp), XRP_DECIMALS, owner);
        settler = new IntentSettler(address(manager), address(oracle), address(registry), owner);
    }

    function _configure() internal {
        vm.startPrank(owner);

        manager.setAuthorized(address(settler), true);
        manager.setAuthorized(relayer, true);

        manager.configureSourceChain(
            CHAIN_XRPL,
            SourceChainConfig({
                enabled: true,
                decimals: XRP_DECIMALS,
                feedId: FeedIds.XRP_USD,
                sourceId: XRPL_SOURCE_ID,
                depositAddressHash: keccak256(bytes(XRPL_DEPOSIT_ADDRESS)),
                name: "XRPL",
                symbol: "XRP",
                depositAddress: XRPL_DEPOSIT_ADDRESS
            }),
            MIN_DEPOSIT,
            MAX_DEPOSIT
        );

        manager.configureToken(
            address(usdc), TokenConfig({enabled: true, decimals: 6, feedId: FeedIds.USDC_USD, symbol: "USDC"})
        );
        manager.configureToken(
            address(fxrp), TokenConfig({enabled: true, decimals: 6, feedId: FeedIds.XRP_USD, symbol: "FXRP"})
        );

        minter.setAuthorized(address(settler), true);

        settler.setMinter(address(minter));
        settler.setPool(address(usdc), address(pool));
        settler.setProtocolFee(30, feeRecipient);
        settler.setRelayer(relayer, true);

        vm.stopPrank();
    }

    function _seedLiquidity() internal {
        fxrp.mint(lp, POOL_FXRP);
        usdc.mint(lp, POOL_USDC);

        vm.startPrank(lp);
        fxrp.approve(address(pool), type(uint256).max);
        usdc.approve(address(pool), type(uint256).max);
        pool.addLiquidity(POOL_FXRP, POOL_USDC, 0, 0, lp, 0);
        vm.stopPrank();
    }

    function _fundMinterReserve(uint256 amount) internal {
        fxrp.mint(address(this), amount);
        fxrp.approve(address(minter), amount);
        minter.fundReserve(amount);
    }

    /* ------------------------------------------------------------------ */
    /*                               prices                                */
    /* ------------------------------------------------------------------ */

    /// @notice Re-stamps both feeds at the current block timestamp.
    function refreshPrices() internal {
        ftso.setFeedNow(FeedIds.XRP_USD, XRP_PRICE, PRICE_DECIMALS);
        ftso.setFeedNow(FeedIds.USDC_USD, USDC_PRICE, PRICE_DECIMALS);
        ftso.setFeedNow(FeedIds.FLR_USD, 2_150, PRICE_DECIMALS);
        ftso.setFeedNow(FeedIds.BTC_USD, 9_500_000_000, PRICE_DECIMALS);
    }

    function setXrpPrice(uint256 value) internal {
        ftso.setFeedNow(FeedIds.XRP_USD, value, PRICE_DECIMALS);
    }

    /* ------------------------------------------------------------------ */
    /*                               intents                               */
    /* ------------------------------------------------------------------ */

    function createIntent(address who, uint256 amountDrops, address destinationToken, uint16 slippageBps)
        internal
        returns (bytes32 intentId)
    {
        vm.prank(who);
        (intentId,,) = manager.createIntent(
            CHAIN_XRPL, amountDrops, destinationToken, 0, block.timestamp + 1 hours, slippageBps
        );
    }

    function createIntentWithMinOut(
        address who,
        uint256 amountDrops,
        address destinationToken,
        uint256 minOut,
        uint16 slippageBps
    ) internal returns (bytes32 intentId) {
        vm.prank(who);
        (intentId,,) = manager.createIntent(
            CHAIN_XRPL, amountDrops, destinationToken, minOut, block.timestamp + 1 hours, slippageBps
        );
    }

    /* ------------------------------------------------------------------ */
    /*                             FDC proofs                              */
    /* ------------------------------------------------------------------ */

    /// @notice A well-formed Payment response for a deposit into the configured XRPL address.
    function paymentResponse(bytes32 paymentReference, uint256 receivedDrops, bytes32 sourceTxId)
        internal
        view
        returns (IPayment.Response memory response)
    {
        response = IPayment.Response({
            attestationType: bytes32("Payment"),
            sourceId: XRPL_SOURCE_ID,
            votingRound: VOTING_ROUND,
            lowestUsedTimestamp: uint64(block.timestamp),
            requestBody: IPayment.RequestBody({transactionId: sourceTxId, inUtxo: 0, utxo: 0}),
            responseBody: IPayment.ResponseBody({
                blockNumber: 90_000_000,
                blockTimestamp: uint64(block.timestamp),
                sourceAddressHash: keccak256(bytes("rUserSourceAddressOnXRPL00000001")),
                sourceAddressesRoot: bytes32(0),
                receivingAddressHash: keccak256(bytes(XRPL_DEPOSIT_ADDRESS)),
                intendedReceivingAddressHash: keccak256(bytes(XRPL_DEPOSIT_ADDRESS)),
                spentAmount: int256(receivedDrops + 12), // + XRPL network fee
                intendedSpentAmount: int256(receivedDrops + 12),
                receivedAmount: int256(receivedDrops),
                intendedReceivedAmount: int256(receivedDrops),
                standardPaymentReference: paymentReference,
                oneToOne: true,
                status: 0
            })
        });
    }

    /// @notice Publishes `response` as a single-leaf Merkle root and returns the matching proof.
    function commit(IPayment.Response memory response) internal returns (IPayment.Proof memory proof) {
        bytes32 leaf = keccak256(abi.encode(response));
        fdc.setMerkleRoot(response.votingRound, leaf);
        proof = IPayment.Proof({merkleProof: new bytes32[](0), data: response});
    }

    /// @notice Publishes `response` alongside `sibling` in a two-leaf tree, exercising the
    ///         real sibling-hashing path of {MerkleProof}.
    function commitWithSibling(IPayment.Response memory response, bytes32 sibling)
        internal
        returns (IPayment.Proof memory proof)
    {
        bytes32 leaf = keccak256(abi.encode(response));
        // OpenZeppelin's MerkleProof hashes sorted pairs with abi.encodePacked.
        bytes32 root = leaf < sibling
            ? keccak256(abi.encodePacked(leaf, sibling))
            : keccak256(abi.encodePacked(sibling, leaf));
        fdc.setMerkleRoot(response.votingRound, root);

        bytes32[] memory branch = new bytes32[](1);
        branch[0] = sibling;
        proof = IPayment.Proof({merkleProof: branch, data: response});
    }

    /// @notice The common case: build, commit and return a valid proof for `intentId`.
    function validProof(bytes32 intentId, uint256 receivedDrops, bytes32 sourceTxId)
        internal
        returns (IPayment.Proof memory)
    {
        return commit(paymentResponse(intentId, receivedDrops, sourceTxId));
    }

    /* ------------------------------------------------------------------ */
    /*                              utilities                              */
    /* ------------------------------------------------------------------ */

    function txid(uint256 n) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("xrpl-tx", n));
    }

    function statusOf(bytes32 intentId) internal view returns (IntentStatus) {
        return manager.getIntent(intentId).status;
    }
}
