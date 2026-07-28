// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {BaseTest} from "./Base.t.sol";
import {IntentManager} from "../src/IntentManager.sol";
import {
    IIntentManager, Intent, IntentStatus, SourceChainConfig, TokenConfig
} from "../src/interfaces/IIntentManager.sol";
import {FeedIds} from "../src/libraries/FeedIds.sol";

contract IntentManagerTest is BaseTest {
    /* ------------------------------- creation ------------------------------- */

    function test_createIntentStoresTermsAndReturnsDepositInstructions() public {
        vm.prank(user);
        (bytes32 intentId, string memory depositAddress, uint32 tag) = manager.createIntent(
            CHAIN_XRPL, 500e6, address(usdc), 300e6, block.timestamp + 1 hours, 100
        );

        Intent memory intent = manager.getIntent(intentId);
        assertEq(intent.user, user);
        assertEq(intent.sourceChain, CHAIN_XRPL);
        assertEq(intent.sourceToken, "XRP");
        assertEq(intent.sourceAmount, 500e6);
        assertEq(intent.destinationToken, address(usdc));
        assertEq(intent.minOutputAmount, 300e6);
        assertEq(intent.maxSlippageBps, 100);
        assertEq(uint8(intent.status), uint8(IntentStatus.Pending));
        assertEq(intent.createdAt, uint64(block.timestamp));
        assertEq(intent.outputAmount, 0);

        assertEq(depositAddress, XRPL_DEPOSIT_ADDRESS, "deposit address returned to the caller");
        assertEq(tag, manager.FIRST_DESTINATION_TAG(), "first destination tag");
        assertEq(manager.intentByDestinationTag(tag), intentId, "tag maps back to the intent");
    }

    function test_intentIdsAreUniquePerUserAndDomainSeparated() public {
        bytes32 a = createIntent(user, 500e6, address(usdc), 100);
        bytes32 b = createIntent(user, 500e6, address(usdc), 100);
        assertTrue(a != b, "same terms, different nonce");

        bytes32 expected = keccak256(abi.encode(block.chainid, address(manager), user, uint256(0)));
        assertEq(a, expected, "id binds chain, deployment, user and nonce");
    }

    function test_destinationTagsIncrementAndNeverCollide() public {
        bytes32 a = createIntent(user, 500e6, address(usdc), 100);
        bytes32 b = createIntent(attacker, 500e6, address(usdc), 100);
        uint32 tagA = manager.getIntent(a).xrplDestinationTag;
        uint32 tagB = manager.getIntent(b).xrplDestinationTag;
        assertEq(tagB, tagA + 1);
    }

    function test_createIntentTracksUserHistory() public {
        bytes32 a = createIntent(user, 500e6, address(usdc), 100);
        bytes32 b = createIntent(user, 600e6, address(usdc), 100);

        bytes32[] memory all = manager.getUserIntents(user);
        assertEq(all.length, 2);
        assertEq(all[0], a);
        assertEq(all[1], b);
        assertEq(manager.getUserIntentCount(user), 2);
        assertEq(manager.totalIntents(), 2);

        bytes32[] memory page = manager.getUserIntentsPaged(user, 1, 10);
        assertEq(page.length, 1);
        assertEq(page[0], b);
        assertEq(manager.getUserIntentsPaged(user, 5, 10).length, 0, "offset past the end");
    }

    /* ------------------------------ validation ------------------------------ */

    function test_rejectsDisabledSourceChain() public {
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(IIntentManager.SourceChainDisabled.selector, CHAIN_BTC));
        manager.createIntent(CHAIN_BTC, 500e6, address(usdc), 0, block.timestamp + 1 hours, 100);
    }

    function test_rejectsDisabledDestinationToken() public {
        address random = makeAddr("randomToken");
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(IIntentManager.TokenDisabled.selector, random));
        manager.createIntent(CHAIN_XRPL, 500e6, random, 0, block.timestamp + 1 hours, 100);
    }

    function test_rejectsAmountBelowMinimum() public {
        vm.prank(user);
        vm.expectRevert(
            abi.encodeWithSelector(IIntentManager.AmountOutOfRange.selector, 1, MIN_DEPOSIT, MAX_DEPOSIT)
        );
        manager.createIntent(CHAIN_XRPL, 1, address(usdc), 0, block.timestamp + 1 hours, 100);
    }

    function test_rejectsAmountAboveMaximum() public {
        vm.prank(user);
        vm.expectRevert(
            abi.encodeWithSelector(
                IIntentManager.AmountOutOfRange.selector, MAX_DEPOSIT + 1, MIN_DEPOSIT, MAX_DEPOSIT
            )
        );
        manager.createIntent(CHAIN_XRPL, MAX_DEPOSIT + 1, address(usdc), 0, block.timestamp + 1 hours, 100);
    }

    function test_rejectsExcessiveSlippage() public {
        vm.prank(user);
        vm.expectRevert(
            abi.encodeWithSelector(IIntentManager.SlippageTooHigh.selector, uint16(5001), uint16(5000))
        );
        manager.createIntent(CHAIN_XRPL, 500e6, address(usdc), 0, block.timestamp + 1 hours, 5001);
    }

    function test_rejectsDeadlineTooSoon() public {
        uint256 tooSoon = START_TIME + 60;
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(IIntentManager.DeadlineInPast.selector, tooSoon));
        manager.createIntent(CHAIN_XRPL, 500e6, address(usdc), 0, tooSoon, 100);
    }

    function test_rejectsDeadlineTooFar() public {
        uint256 tooFar = START_TIME + 8 days;
        vm.prank(user);
        vm.expectRevert(
            abi.encodeWithSelector(IIntentManager.DeadlineTooFar.selector, tooFar, START_TIME + 7 days)
        );
        manager.createIntent(CHAIN_XRPL, 500e6, address(usdc), 0, tooFar, 100);
    }

    function test_createIntentRevertsWhenPaused() public {
        vm.prank(owner);
        manager.pause();
        vm.prank(user);
        vm.expectRevert();
        manager.createIntent(CHAIN_XRPL, 500e6, address(usdc), 0, block.timestamp + 1 hours, 100);
    }

    /* ----------------------------- cancellation ----------------------------- */

    function test_userCanCancelPendingIntent() public {
        bytes32 intentId = createIntent(user, 500e6, address(usdc), 100);
        vm.prank(user);
        manager.cancelIntent(intentId);
        assertEq(uint8(statusOf(intentId)), uint8(IntentStatus.Cancelled));
    }

    function test_onlyOwnerOfIntentCanCancel() public {
        bytes32 intentId = createIntent(user, 500e6, address(usdc), 100);
        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(IIntentManager.NotIntentOwner.selector, intentId, attacker));
        manager.cancelIntent(intentId);
    }

    function test_cannotCancelAfterDeposit() public {
        bytes32 intentId = createIntent(user, 500e6, address(usdc), 100);
        vm.prank(relayer);
        manager.markDeposited(intentId, txid(1));

        vm.prank(user);
        vm.expectRevert(
            abi.encodeWithSelector(
                IIntentManager.InvalidStatus.selector, intentId, IntentStatus.Deposited, IntentStatus.Pending
            )
        );
        manager.cancelIntent(intentId);
    }

    function test_cannotCancelTwice() public {
        bytes32 intentId = createIntent(user, 500e6, address(usdc), 100);
        vm.startPrank(user);
        manager.cancelIntent(intentId);
        vm.expectRevert();
        manager.cancelIntent(intentId);
        vm.stopPrank();
    }

    function test_unknownIntentReverts() public {
        bytes32 ghost = keccak256("ghost");
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(IIntentManager.UnknownIntent.selector, ghost));
        manager.cancelIntent(ghost);
    }

    /* ------------------------------ lifecycle ------------------------------- */

    function test_markDepositedRequiresAuthorization() public {
        bytes32 intentId = createIntent(user, 500e6, address(usdc), 100);
        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(IIntentManager.NotAuthorized.selector, attacker));
        manager.markDeposited(intentId, txid(1));
    }

    function test_lockForSettlementRequiresAuthorization() public {
        bytes32 intentId = createIntent(user, 500e6, address(usdc), 100);
        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(IIntentManager.NotAuthorized.selector, attacker));
        manager.lockForSettlement(intentId);
    }

    function test_lockIsExclusive() public {
        bytes32 intentId = createIntent(user, 500e6, address(usdc), 100);
        vm.startPrank(relayer);
        manager.lockForSettlement(intentId);
        assertEq(uint8(statusOf(intentId)), uint8(IntentStatus.Settling));
        // A second lock on the same intent must fail — this is the re-entrancy guard.
        vm.expectRevert(
            abi.encodeWithSelector(
                IIntentManager.InvalidStatus.selector, intentId, IntentStatus.Settling, IntentStatus.Deposited
            )
        );
        manager.lockForSettlement(intentId);
        vm.stopPrank();
    }

    function test_unlockReturnsIntentToDeposited() public {
        bytes32 intentId = createIntent(user, 500e6, address(usdc), 100);
        vm.startPrank(relayer);
        manager.lockForSettlement(intentId);
        manager.unlock(intentId);
        vm.stopPrank();
        assertEq(uint8(statusOf(intentId)), uint8(IntentStatus.Deposited));
    }

    function test_markSettledRequiresLock() public {
        bytes32 intentId = createIntent(user, 500e6, address(usdc), 100);
        vm.prank(relayer);
        vm.expectRevert(
            abi.encodeWithSelector(
                IIntentManager.InvalidStatus.selector, intentId, IntentStatus.Pending, IntentStatus.Settling
            )
        );
        manager.markSettled(intentId, 1);
    }

    function test_markSettledRecordsOutput() public {
        bytes32 intentId = createIntent(user, 500e6, address(usdc), 100);
        vm.startPrank(relayer);
        manager.lockForSettlement(intentId);
        manager.markSettled(intentId, 311e6);
        vm.stopPrank();

        Intent memory intent = manager.getIntent(intentId);
        assertEq(uint8(intent.status), uint8(IntentStatus.Settled));
        assertEq(intent.outputAmount, 311e6);
        assertEq(intent.settledAt, uint64(block.timestamp));
    }

    /* ------------------------------ expiration ------------------------------ */

    function test_cannotExpireBeforeDeadline() public {
        bytes32 intentId = createIntent(user, 500e6, address(usdc), 100);
        uint256 deadline = manager.getIntent(intentId).deadline;
        assertFalse(manager.isExpirable(intentId));
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(IIntentManager.IntentNotExpired.selector, intentId, deadline));
        manager.markExpired(intentId);
    }

    function test_expireAfterDeadline() public {
        bytes32 intentId = createIntent(user, 500e6, address(usdc), 100);
        vm.warp(START_TIME + 2 hours);
        assertTrue(manager.isExpirable(intentId));
        vm.prank(relayer);
        manager.markExpired(intentId);
        assertEq(uint8(statusOf(intentId)), uint8(IntentStatus.Expired));
    }

    function test_cannotExpireSettledIntent() public {
        bytes32 intentId = createIntent(user, 500e6, address(usdc), 100);
        vm.startPrank(relayer);
        manager.lockForSettlement(intentId);
        manager.markSettled(intentId, 1);
        vm.stopPrank();

        vm.warp(START_TIME + 2 hours);
        assertFalse(manager.isExpirable(intentId));
        vm.prank(relayer);
        vm.expectRevert();
        manager.markExpired(intentId);
    }

    /* --------------------------------- admin -------------------------------- */

    function test_onlyOwnerCanConfigure() public {
        SourceChainConfig memory config = manager.getSourceChainConfig(CHAIN_XRPL);
        vm.prank(attacker);
        vm.expectRevert();
        manager.configureSourceChain(CHAIN_BTC, config, 0, 1);

        vm.prank(attacker);
        vm.expectRevert();
        manager.setAuthorized(attacker, true);

        vm.prank(attacker);
        vm.expectRevert();
        manager.configureToken(address(usdc), TokenConfig(true, 6, FeedIds.USDC_USD, "USDC"));
    }

    function test_configureSourceChainRejectsInvertedRange() public {
        SourceChainConfig memory config = manager.getSourceChainConfig(CHAIN_XRPL);
        vm.prank(owner);
        vm.expectRevert("IntentManager: bad amount range");
        manager.configureSourceChain(CHAIN_BTC, config, 100, 99);
    }

    function test_sourceChainConfigIsReadableByFrontend() public view {
        SourceChainConfig memory config = manager.getSourceChainConfig(CHAIN_XRPL);
        assertTrue(config.enabled);
        assertEq(config.name, "XRPL");
        assertEq(config.symbol, "XRP");
        assertEq(config.depositAddress, XRPL_DEPOSIT_ADDRESS);
        assertEq(config.depositAddressHash, keccak256(bytes(XRPL_DEPOSIT_ADDRESS)));
        assertEq(config.feedId, FeedIds.XRP_USD);
        assertEq(config.sourceId, XRPL_SOURCE_ID);
        assertEq(config.decimals, 6);
    }

    function test_ownershipTransferIsTwoStep() public {
        address newOwner = makeAddr("newOwner");
        vm.prank(owner);
        manager.transferOwnership(newOwner);
        assertEq(manager.owner(), owner, "not transferred until accepted");

        vm.prank(newOwner);
        manager.acceptOwnership();
        assertEq(manager.owner(), newOwner);
    }
}
