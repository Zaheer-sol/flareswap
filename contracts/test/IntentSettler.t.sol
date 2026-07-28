// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {BaseTest} from "./Base.t.sol";
import {IntentSettler} from "../src/IntentSettler.sol";
import {PriceOracle} from "../src/PriceOracle.sol";
import {LiquidityPool} from "../src/LiquidityPool.sol";
import {IPayment} from "../src/interfaces/IPayment.sol";
import {IIntentManager, Intent, IntentStatus, SourceChainConfig} from "../src/interfaces/IIntentManager.sol";
import {FeedIds} from "../src/libraries/FeedIds.sol";

contract IntentSettlerTest is BaseTest {
    uint256 internal constant DEPOSIT = 500e6; // 500 XRP in drops

    /* ------------------------------------------------------------------ */
    /*                            happy path                               */
    /* ------------------------------------------------------------------ */

    function test_settleDeliversUsdcToTheUser() public {
        bytes32 intentId = createIntent(user, DEPOSIT, address(usdc), 100);
        IPayment.Proof memory proof = validProof(intentId, DEPOSIT, txid(1));

        uint256 expectedAmm = pool.getAmountOut(address(fxrp), DEPOSIT - (DEPOSIT * 30) / 10_000);

        vm.prank(relayer);
        uint256 out = settler.settleIntent(intentId, proof);

        assertEq(out, expectedAmm, "delivered exactly the AMM output");
        assertEq(usdc.balanceOf(user), out, "user holds the USDC");
        assertEq(uint8(statusOf(intentId)), uint8(IntentStatus.Settled));

        Intent memory intent = manager.getIntent(intentId);
        assertEq(intent.outputAmount, out);
        assertEq(intent.settledAt, uint64(block.timestamp));
        assertEq(settler.totalSettled(), 1);
        assertEq(settler.totalOutputDelivered(address(usdc)), out);
    }

    function test_settleTakesProtocolFeeInFAsset() public {
        bytes32 intentId = createIntent(user, DEPOSIT, address(usdc), 100);
        IPayment.Proof memory proof = validProof(intentId, DEPOSIT, txid(1));

        vm.prank(relayer);
        settler.settleIntent(intentId, proof);

        assertEq(fxrp.balanceOf(feeRecipient), (DEPOSIT * 30) / 10_000, "0.30% of the minted FXRP");
    }

    function test_settledOutputIsCloseToFtsoFairValue() public {
        bytes32 intentId = createIntent(user, DEPOSIT, address(usdc), 100);
        IPayment.Proof memory proof = validProof(intentId, DEPOSIT, txid(1));

        vm.prank(relayer);
        uint256 out = settler.settleIntent(intentId, proof);

        // 500 XRP at 0.6248 == 312.40 USDC, less the 0.30% protocol fee and 0.30% AMM fee.
        uint256 oracleValue = oracle.getQuote(FeedIds.XRP_USD, FeedIds.USDC_USD, DEPOSIT, 6, 6);
        assertEq(oracleValue, 312.4e6);
        assertApproxEqRel(out, (oracleValue * 9940) / 10_000, 2e15, "within ~0.2% of fair value net of fees");
    }

    function test_settleIsPermissionlessByDefault() public {
        bytes32 intentId = createIntent(user, DEPOSIT, address(usdc), 100);
        IPayment.Proof memory proof = validProof(intentId, DEPOSIT, txid(1));

        // A random address may trigger settlement — the proof authorises it, not the caller,
        // and the output can only ever go to intent.user.
        vm.prank(attacker);
        settler.settleIntent(intentId, proof);
        assertEq(usdc.balanceOf(user), manager.getIntent(intentId).outputAmount);
        assertEq(usdc.balanceOf(attacker), 0, "caller receives nothing");
    }

    function test_settleFromDepositedState() public {
        bytes32 intentId = createIntent(user, DEPOSIT, address(usdc), 100);
        vm.prank(relayer);
        manager.markDeposited(intentId, txid(1));

        IPayment.Proof memory proof = validProof(intentId, DEPOSIT, txid(1));
        vm.prank(relayer);
        settler.settleIntent(intentId, proof);
        assertEq(uint8(statusOf(intentId)), uint8(IntentStatus.Settled));
    }

    function test_settleDeliversFxrpDirectlyWhenRequested() public {
        bytes32 intentId = createIntent(user, DEPOSIT, address(fxrp), 100);
        IPayment.Proof memory proof = validProof(intentId, DEPOSIT, txid(1));

        vm.prank(relayer);
        uint256 out = settler.settleIntent(intentId, proof);

        assertEq(out, DEPOSIT - (DEPOSIT * 30) / 10_000, "no AMM hop, just the fee");
        assertEq(fxrp.balanceOf(user), out);
    }

    function test_settleWithMultiLeafMerkleProof() public {
        bytes32 intentId = createIntent(user, DEPOSIT, address(usdc), 100);
        IPayment.Proof memory proof =
            commitWithSibling(paymentResponse(intentId, DEPOSIT, txid(1)), keccak256("some other attestation"));

        vm.prank(relayer);
        settler.settleIntent(intentId, proof);
        assertEq(uint8(statusOf(intentId)), uint8(IntentStatus.Settled));
    }

    function test_overpaymentIsCreditedInFull() public {
        bytes32 intentId = createIntent(user, DEPOSIT, address(usdc), 100);
        // The user actually sent 600 XRP against a 500 XRP intent.
        IPayment.Proof memory proof = validProof(intentId, 600e6, txid(1));

        // Quote against the pre-trade reserves — the swap itself moves them.
        uint256 expected = pool.getAmountOut(address(fxrp), 600e6 - (600e6 * 30) / 10_000);

        vm.prank(relayer);
        uint256 out = settler.settleIntent(intentId, proof);

        assertEq(out, expected, "settles on what actually arrived, not what was declared");
    }

    /* ------------------------------------------------------------------ */
    /*                        proof validation                             */
    /* ------------------------------------------------------------------ */

    function test_rejectsUnprovenPayment() public {
        bytes32 intentId = createIntent(user, DEPOSIT, address(usdc), 100);
        // Build a response but never publish its Merkle root.
        IPayment.Proof memory proof =
            IPayment.Proof({merkleProof: new bytes32[](0), data: paymentResponse(intentId, DEPOSIT, txid(1))});

        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(IntentSettler.InvalidProof.selector, intentId));
        settler.settleIntent(intentId, proof);
    }

    function test_rejectsTamperedAmount() public {
        bytes32 intentId = createIntent(user, DEPOSIT, address(usdc), 100);
        IPayment.Proof memory proof = validProof(intentId, DEPOSIT, txid(1));

        // Inflate the received amount after the root was committed: the leaf no longer matches.
        proof.data.responseBody.receivedAmount = int256(50_000e6);

        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(IntentSettler.InvalidProof.selector, intentId));
        settler.settleIntent(intentId, proof);
    }

    function test_rejectsWrongAttestationType() public {
        bytes32 intentId = createIntent(user, DEPOSIT, address(usdc), 100);
        IPayment.Response memory response = paymentResponse(intentId, DEPOSIT, txid(1));
        response.attestationType = bytes32("BalanceDecreasingTransaction");
        IPayment.Proof memory proof = commit(response);

        vm.prank(relayer);
        vm.expectRevert(
            abi.encodeWithSelector(
                IntentSettler.WrongAttestationType.selector,
                bytes32("Payment"),
                bytes32("BalanceDecreasingTransaction")
            )
        );
        settler.settleIntent(intentId, proof);
    }

    function test_rejectsWrongSourceChain() public {
        bytes32 intentId = createIntent(user, DEPOSIT, address(usdc), 100);
        IPayment.Response memory response = paymentResponse(intentId, DEPOSIT, txid(1));
        response.sourceId = bytes32("testBTC");
        IPayment.Proof memory proof = commit(response);

        vm.prank(relayer);
        vm.expectRevert(
            abi.encodeWithSelector(IntentSettler.WrongSourceId.selector, XRPL_SOURCE_ID, bytes32("testBTC"))
        );
        settler.settleIntent(intentId, proof);
    }

    function test_rejectsFailedPayment() public {
        bytes32 intentId = createIntent(user, DEPOSIT, address(usdc), 100);
        IPayment.Response memory response = paymentResponse(intentId, DEPOSIT, txid(1));
        response.responseBody.status = 1; // failed, sender's fault
        IPayment.Proof memory proof = commit(response);

        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(IntentSettler.PaymentNotSuccessful.selector, uint8(1)));
        settler.settleIntent(intentId, proof);
    }

    /// @dev The single most important check: a payment carrying someone else's reference — or
    ///      none at all — must not settle this intent.
    function test_rejectsPaymentForADifferentIntent() public {
        bytes32 mine = createIntent(user, DEPOSIT, address(usdc), 100);
        bytes32 theirs = createIntent(attacker, DEPOSIT, address(usdc), 100);
        IPayment.Proof memory proof = validProof(theirs, DEPOSIT, txid(1));

        vm.prank(attacker);
        vm.expectRevert(
            abi.encodeWithSelector(IntentSettler.PaymentReferenceMismatch.selector, mine, theirs)
        );
        settler.settleIntent(mine, proof);
    }

    function test_rejectsPaymentWithNoReference() public {
        bytes32 intentId = createIntent(user, DEPOSIT, address(usdc), 100);
        IPayment.Proof memory proof = validProof(bytes32(0), DEPOSIT, txid(1));

        vm.prank(relayer);
        vm.expectRevert(
            abi.encodeWithSelector(IntentSettler.PaymentReferenceMismatch.selector, intentId, bytes32(0))
        );
        settler.settleIntent(intentId, proof);
    }

    /// @dev A real, FDC-attested XRPL payment to somebody else's wallet must not mint us FXRP.
    function test_rejectsPaymentToAnotherAddress() public {
        bytes32 intentId = createIntent(user, DEPOSIT, address(usdc), 100);
        IPayment.Response memory response = paymentResponse(intentId, DEPOSIT, txid(1));
        response.responseBody.receivingAddressHash = keccak256(bytes("rAttackerOwnedAddress0000000001"));
        IPayment.Proof memory proof = commit(response);

        vm.prank(attacker);
        vm.expectRevert(
            abi.encodeWithSelector(
                IntentSettler.WrongReceivingAddress.selector,
                keccak256(bytes(XRPL_DEPOSIT_ADDRESS)),
                keccak256(bytes("rAttackerOwnedAddress0000000001"))
            )
        );
        settler.settleIntent(intentId, proof);
    }

    function test_rejectsUnderpayment() public {
        bytes32 intentId = createIntent(user, DEPOSIT, address(usdc), 100);
        IPayment.Proof memory proof = validProof(intentId, DEPOSIT - 1, txid(1));

        vm.prank(relayer);
        vm.expectRevert(
            abi.encodeWithSelector(IntentSettler.DepositTooSmall.selector, DEPOSIT - 1, DEPOSIT)
        );
        settler.settleIntent(intentId, proof);
    }

    function test_rejectsNonPositiveAmount() public {
        bytes32 intentId = createIntent(user, DEPOSIT, address(usdc), 100);
        IPayment.Response memory response = paymentResponse(intentId, DEPOSIT, txid(1));
        response.responseBody.receivedAmount = -1;
        IPayment.Proof memory proof = commit(response);

        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(IntentSettler.NonPositiveAmount.selector, int256(-1)));
        settler.settleIntent(intentId, proof);
    }

    /* ------------------------------------------------------------------ */
    /*                              replay                                 */
    /* ------------------------------------------------------------------ */

    function test_sameIntentCannotSettleTwice() public {
        bytes32 intentId = createIntent(user, DEPOSIT, address(usdc), 100);
        IPayment.Proof memory proof = validProof(intentId, DEPOSIT, txid(1));

        vm.startPrank(relayer);
        settler.settleIntent(intentId, proof);
        vm.expectRevert(
            abi.encodeWithSelector(
                IIntentManager.InvalidStatus.selector, intentId, IntentStatus.Settled, IntentStatus.Deposited
            )
        );
        settler.settleIntent(intentId, proof);
        vm.stopPrank();
    }

    /// @dev The replay guard that matters: one XRPL payment, many intents. Without
    ///      `settledByTx` an attacker could open N intents and drain the FXRP reserve with a
    ///      single real deposit.
    function test_oneSourceTransactionCannotFundTwoIntents() public {
        bytes32 first = createIntent(user, DEPOSIT, address(usdc), 100);
        vm.prank(relayer);
        settler.settleIntent(first, validProof(first, DEPOSIT, txid(1)));

        // Second intent, same XRPL transaction id, re-referenced.
        bytes32 second = createIntent(user, DEPOSIT, address(usdc), 100);
        IPayment.Proof memory replayed = validProof(second, DEPOSIT, txid(1));

        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(IntentSettler.ProofAlreadyUsed.selector, txid(1), first));
        settler.settleIntent(second, replayed);

        assertTrue(settler.isProofSpent(txid(1)));
    }

    function test_distinctTransactionsSettleDistinctIntents() public {
        bytes32 first = createIntent(user, DEPOSIT, address(usdc), 100);
        bytes32 second = createIntent(user, DEPOSIT, address(usdc), 100);

        vm.startPrank(relayer);
        settler.settleIntent(first, validProof(first, DEPOSIT, txid(1)));
        settler.settleIntent(second, validProof(second, DEPOSIT, txid(2)));
        vm.stopPrank();

        assertEq(settler.totalSettled(), 2);
        assertEq(settler.settledByTx(txid(1)), first);
        assertEq(settler.settledByTx(txid(2)), second);
    }

    function test_cancelledIntentCannotSettle() public {
        bytes32 intentId = createIntent(user, DEPOSIT, address(usdc), 100);
        vm.prank(user);
        manager.cancelIntent(intentId);

        IPayment.Proof memory proof = validProof(intentId, DEPOSIT, txid(1));
        vm.prank(relayer);
        vm.expectRevert();
        settler.settleIntent(intentId, proof);
    }

    /* ------------------------------------------------------------------ */
    /*                        deadline & slippage                          */
    /* ------------------------------------------------------------------ */

    function test_rejectsSettlementAfterDeadline() public {
        bytes32 intentId = createIntent(user, DEPOSIT, address(usdc), 100);
        uint256 deadline = manager.getIntent(intentId).deadline;

        vm.warp(START_TIME + 2 hours);
        refreshPrices();
        IPayment.Proof memory proof = validProof(intentId, DEPOSIT, txid(1));

        vm.prank(relayer);
        vm.expectRevert(
            abi.encodeWithSelector(IntentSettler.IntentDeadlinePassed.selector, intentId, deadline)
        );
        settler.settleIntent(intentId, proof);
    }

    function test_rejectsOutputBelowUserMinimum() public {
        // Ask for 400 USDC out of 500 XRP — impossible at 0.6248.
        bytes32 intentId = createIntentWithMinOut(user, DEPOSIT, address(usdc), 400e6, 5000);
        IPayment.Proof memory proof = validProof(intentId, DEPOSIT, txid(1));

        vm.prank(relayer);
        vm.expectRevert(); // LiquidityPool.InsufficientOutputAmount, bubbled through the settler
        settler.settleIntent(intentId, proof);
    }

    /// @dev Pool drifted away from the oracle. Even with no explicit `minOutputAmount`, the
    ///      FTSO-derived floor must stop the settlement.
    function test_rejectsWhenPoolPriceDivergesFromOracle() public {
        bytes32 intentId = createIntent(user, DEPOSIT, address(usdc), 50); // 0.5% tolerance

        // Drain USDC out of the pool so FXRP becomes much cheaper than the oracle says.
        address whale = makeAddr("whale");
        fxrp.mint(whale, 400_000e6);
        vm.startPrank(whale);
        fxrp.approve(address(pool), type(uint256).max);
        pool.swap(address(fxrp), 400_000e6, 0, whale, 0);
        vm.stopPrank();

        IPayment.Proof memory proof = validProof(intentId, DEPOSIT, txid(1));
        vm.prank(relayer);
        vm.expectRevert(); // pool's min-out check trips on the oracle floor
        settler.settleIntent(intentId, proof);

        assertEq(usdc.balanceOf(user), 0, "user was not given a bad fill");
    }

    function test_generousSlippageAllowsADivergedPool() public {
        bytes32 intentId = createIntent(user, DEPOSIT, address(usdc), 5000); // 50% tolerance

        address whale = makeAddr("whale");
        fxrp.mint(whale, 400_000e6);
        vm.startPrank(whale);
        fxrp.approve(address(pool), type(uint256).max);
        pool.swap(address(fxrp), 400_000e6, 0, whale, 0);
        vm.stopPrank();

        IPayment.Proof memory proof = validProof(intentId, DEPOSIT, txid(1));
        vm.prank(relayer);
        uint256 out = settler.settleIntent(intentId, proof);
        assertGt(out, 0);
        assertEq(usdc.balanceOf(user), out);
    }

    function test_rejectsSettlementOnStalePrice() public {
        bytes32 intentId = createIntent(user, DEPOSIT, address(usdc), 100);
        IPayment.Proof memory proof = validProof(intentId, DEPOSIT, txid(1));

        // Prices go stale but the deadline has not passed.
        vm.warp(START_TIME + 45 minutes);

        vm.prank(relayer);
        vm.expectRevert(); // PriceOracle.PriceStale
        settler.settleIntent(intentId, proof);
    }

    /* ------------------------------------------------------------------ */
    /*                        access & configuration                       */
    /* ------------------------------------------------------------------ */

    function test_permissionlessCanBeDisabled() public {
        vm.prank(owner);
        settler.setPermissionless(false);

        bytes32 intentId = createIntent(user, DEPOSIT, address(usdc), 100);
        IPayment.Proof memory proof = validProof(intentId, DEPOSIT, txid(1));

        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(IntentSettler.NotRelayer.selector, attacker));
        settler.settleIntent(intentId, proof);

        vm.prank(relayer);
        settler.settleIntent(intentId, proof);
        assertEq(uint8(statusOf(intentId)), uint8(IntentStatus.Settled));
    }

    function test_pauseStopsSettlement() public {
        vm.prank(owner);
        settler.pause();

        bytes32 intentId = createIntent(user, DEPOSIT, address(usdc), 100);
        IPayment.Proof memory proof = validProof(intentId, DEPOSIT, txid(1));

        vm.prank(relayer);
        vm.expectRevert();
        settler.settleIntent(intentId, proof);

        vm.prank(owner);
        settler.unpause();
        vm.prank(relayer);
        settler.settleIntent(intentId, proof);
    }

    function test_missingPoolRouteReverts() public {
        vm.prank(owner);
        settler.setPool(address(usdc), address(0));

        bytes32 intentId = createIntent(user, DEPOSIT, address(usdc), 100);
        IPayment.Proof memory proof = validProof(intentId, DEPOSIT, txid(1));

        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(IntentSettler.NoPoolForToken.selector, address(usdc)));
        settler.settleIntent(intentId, proof);
    }

    function test_onlyOwnerCanConfigure() public {
        vm.startPrank(attacker);
        vm.expectRevert();
        settler.setMinter(address(minter));
        vm.expectRevert();
        settler.setPool(address(usdc), address(pool));
        vm.expectRevert();
        settler.setProtocolFee(0, attacker);
        vm.expectRevert();
        settler.setRelayer(attacker, true);
        vm.expectRevert();
        settler.setPermissionless(false);
        vm.expectRevert();
        settler.pause();
        vm.stopPrank();
    }

    function test_protocolFeeIsCapped() public {
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(IntentSettler.ProtocolFeeTooHigh.selector, uint16(101), uint16(100))
        );
        settler.setProtocolFee(101, feeRecipient);
    }

    function test_zeroProtocolFeeWorks() public {
        vm.prank(owner);
        settler.setProtocolFee(0, feeRecipient);

        bytes32 intentId = createIntent(user, DEPOSIT, address(usdc), 100);
        vm.prank(relayer);
        settler.settleIntent(intentId, validProof(intentId, DEPOSIT, txid(1)));

        assertEq(fxrp.balanceOf(feeRecipient), 0);
        assertEq(usdc.balanceOf(user), pool.cumulativeVolume0() > 0 ? usdc.balanceOf(user) : 0);
        assertGt(usdc.balanceOf(user), 0);
    }

    /* ------------------------------------------------------------------ */
    /*                        try/catch settlement                         */
    /* ------------------------------------------------------------------ */

    function test_trySettleSucceedsOnValidProof() public {
        bytes32 intentId = createIntent(user, DEPOSIT, address(usdc), 100);
        IPayment.Proof memory proof = validProof(intentId, DEPOSIT, txid(1));

        vm.prank(relayer);
        (bool ok, uint256 out) = settler.trySettleIntent(intentId, proof);
        assertTrue(ok);
        assertGt(out, 0);
        assertEq(uint8(statusOf(intentId)), uint8(IntentStatus.Settled));
    }

    function test_trySettleReportsFailureWithoutReverting() public {
        bytes32 intentId = createIntent(user, DEPOSIT, address(usdc), 100);
        IPayment.Proof memory proof =
            IPayment.Proof({merkleProof: new bytes32[](0), data: paymentResponse(intentId, DEPOSIT, txid(1))});

        vm.prank(relayer);
        vm.expectEmit(true, false, false, true, address(settler));
        emit IntentSettler.SettlementFailed(
            intentId, abi.encodeWithSelector(IntentSettler.InvalidProof.selector, intentId)
        );
        (bool ok, uint256 out) = settler.trySettleIntent(intentId, proof);

        assertFalse(ok);
        assertEq(out, 0);
        // The failed attempt left the intent untouched, so a retry is still possible.
        assertEq(uint8(statusOf(intentId)), uint8(IntentStatus.Pending));
    }

    function test_failedAttemptDoesNotBurnTheReplayGuard() public {
        bytes32 intentId = createIntent(user, DEPOSIT, address(usdc), 100);
        // Underpaid proof: fails after the replay guard would have been written.
        IPayment.Proof memory bad = validProof(intentId, DEPOSIT - 1, txid(1));
        vm.prank(relayer);
        settler.trySettleIntent(intentId, bad);
        assertFalse(settler.isProofSpent(txid(1)), "guard rolled back with the revert");

        // The corrected proof for the same transaction still works.
        IPayment.Proof memory good = validProof(intentId, DEPOSIT, txid(1));
        vm.prank(relayer);
        settler.settleIntent(intentId, good);
        assertEq(uint8(statusOf(intentId)), uint8(IntentStatus.Settled));
    }

    /* ------------------------------------------------------------------ */
    /*                             expiration                              */
    /* ------------------------------------------------------------------ */

    function test_anyoneCanExpireAnOverdueIntent() public {
        bytes32 intentId = createIntent(user, DEPOSIT, address(usdc), 100);
        vm.warp(START_TIME + 2 hours);

        vm.prank(attacker);
        settler.expireIntent(intentId);
        assertEq(uint8(statusOf(intentId)), uint8(IntentStatus.Expired));
    }

    function test_cannotExpireEarly() public {
        bytes32 intentId = createIntent(user, DEPOSIT, address(usdc), 100);
        vm.expectRevert();
        settler.expireIntent(intentId);
    }

    /* ------------------------------------------------------------------ */
    /*                                quote                                */
    /* ------------------------------------------------------------------ */

    function test_quoteMatchesSettlement() public {
        (uint256 expected, uint256 ammOut, uint256 minOut, uint256 fee, uint256 impact) =
            settler.quote(CHAIN_XRPL, DEPOSIT, address(usdc), 100);

        assertEq(fee, (DEPOSIT * 30) / 10_000);
        assertEq(expected, 312.4e6 - oracle.getQuote(FeedIds.XRP_USD, FeedIds.USDC_USD, fee, 6, 6));
        assertGt(ammOut, 0);
        assertLt(ammOut, expected, "AMM output sits below oracle fair value by the swap fee");
        assertGt(impact, 0);
        assertLt(minOut, expected);

        bytes32 intentId = createIntent(user, DEPOSIT, address(usdc), 100);
        vm.prank(relayer);
        uint256 actual = settler.settleIntent(intentId, validProof(intentId, DEPOSIT, txid(1)));
        assertEq(actual, ammOut, "quote is exact when nothing trades in between");
    }

    function test_quoteForFxrpDestinationSkipsTheAmm() public view {
        (uint256 expected, uint256 ammOut, uint256 minOut, uint256 fee, uint256 impact) =
            settler.quote(CHAIN_XRPL, DEPOSIT, address(fxrp), 100);
        assertEq(ammOut, DEPOSIT - fee);
        assertEq(minOut, ammOut);
        assertEq(impact, 0);
        assertEq(expected, DEPOSIT - fee, "FXRP priced on the XRP feed, so 1:1");
    }

    function test_quoteRevertsForUnsupportedToken() public {
        address random = makeAddr("random");
        vm.expectRevert(abi.encodeWithSelector(IntentSettler.DestinationTokenDisabled.selector, random));
        settler.quote(CHAIN_XRPL, DEPOSIT, random, 100);
    }

    /* ------------------------------------------------------------------ */
    /*                                fuzz                                 */
    /* ------------------------------------------------------------------ */

    /// @dev Whatever the deposit size, the user must never receive less than the binding floor,
    ///      and the settler must never keep any of the destination token.
    function testFuzz_settlementNeverShortchangesTheUser(uint96 depositDrops) public {
        uint256 amount = bound(uint256(depositDrops), MIN_DEPOSIT, 50_000e6);

        bytes32 intentId = createIntent(user, amount, address(usdc), 5000);
        IPayment.Proof memory proof = validProof(intentId, amount, txid(1));

        uint256 fee = (amount * 30) / 10_000;
        uint256 expectedOut = oracle.getQuote(FeedIds.XRP_USD, FeedIds.USDC_USD, amount - fee, 6, 6);
        uint256 floor = oracle.slippageFloor(expectedOut, 5000);

        vm.prank(relayer);
        uint256 out = settler.settleIntent(intentId, proof);

        assertGe(out, floor, "output respects the oracle floor");
        assertEq(usdc.balanceOf(user), out, "everything reaches the user");
        assertEq(usdc.balanceOf(address(settler)), 0, "settler keeps no destination token");
        assertEq(fxrp.balanceOf(address(settler)), 0, "settler keeps no FAsset");
    }

    /// @dev No matter which valid intent/proof pair is used, a source transaction settles once.
    function testFuzz_proofIsSingleUse(uint8 attempts) public {
        uint256 n = bound(uint256(attempts), 2, 6);
        bytes32 firstIntent = createIntent(user, DEPOSIT, address(usdc), 5000);
        vm.prank(relayer);
        settler.settleIntent(firstIntent, validProof(firstIntent, DEPOSIT, txid(7)));

        for (uint256 i = 1; i < n; i++) {
            bytes32 next = createIntent(user, DEPOSIT, address(usdc), 5000);
            IPayment.Proof memory replay = validProof(next, DEPOSIT, txid(7));
            vm.prank(relayer);
            vm.expectRevert(
                abi.encodeWithSelector(IntentSettler.ProofAlreadyUsed.selector, txid(7), firstIntent)
            );
            settler.settleIntent(next, replay);
        }
        assertEq(settler.totalSettled(), 1);
    }
}
