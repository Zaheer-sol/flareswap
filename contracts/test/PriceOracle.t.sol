// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {BaseTest} from "./Base.t.sol";
import {PriceOracle} from "../src/PriceOracle.sol";
import {FeedIds} from "../src/libraries/FeedIds.sol";

contract PriceOracleTest is BaseTest {
    function test_resolvesFtsoV2FromRegistry() public view {
        assertEq(oracle.ftsoV2(), address(ftso));
    }

    function test_getPriceReturnsFeedValue() public view {
        (uint256 value, int8 decimals, uint64 timestamp) = oracle.getPrice(FeedIds.XRP_USD);
        assertEq(value, XRP_PRICE);
        assertEq(decimals, PRICE_DECIMALS);
        assertEq(timestamp, uint64(block.timestamp));
    }

    function test_getPriceWadNormalisesTo18Decimals() public view {
        (uint256 priceWad,) = oracle.getPriceWad(FeedIds.XRP_USD);
        // 62480 with 5 decimals == 0.6248 USD
        assertEq(priceWad, 0.6248e18);
    }

    function test_getPriceWadHandlesNegativeFeedDecimals() public {
        // A feed reporting "3" with -2 decimals means 300.
        bytes21 feed = FeedIds.crypto("TEST/USD");
        ftso.setFeedNow(feed, 3, -2);
        (uint256 priceWad,) = oracle.getPriceWad(feed);
        assertEq(priceWad, 300e18);
    }

    function test_getPriceWadHandlesEighteenDecimalFeed() public {
        bytes21 feed = FeedIds.crypto("TEST18/USD");
        ftso.setFeedNow(feed, 1.5e18, 18);
        (uint256 priceWad,) = oracle.getPriceWad(feed);
        assertEq(priceWad, 1.5e18);
    }

    function test_getPriceRevertsWhenStale() public {
        vm.warp(block.timestamp + 301);
        vm.expectRevert(
            abi.encodeWithSelector(
                PriceOracle.PriceStale.selector,
                FeedIds.XRP_USD,
                uint64(START_TIME),
                block.timestamp,
                uint256(300)
            )
        );
        oracle.getPrice(FeedIds.XRP_USD);
    }

    function test_getPriceAcceptsPriceAtExactAgeLimit() public {
        vm.warp(block.timestamp + 300);
        (uint256 value,,) = oracle.getPrice(FeedIds.XRP_USD);
        assertEq(value, XRP_PRICE);
    }

    function test_getPriceRevertsOnFutureTimestamp() public {
        ftso.setFeed(FeedIds.XRP_USD, XRP_PRICE, PRICE_DECIMALS, uint64(block.timestamp + 1));
        vm.expectRevert();
        oracle.getPrice(FeedIds.XRP_USD);
    }

    function test_getPriceRevertsOnZeroValue() public {
        ftso.setFeedNow(FeedIds.XRP_USD, 0, PRICE_DECIMALS);
        vm.expectRevert(abi.encodeWithSelector(PriceOracle.PriceZero.selector, FeedIds.XRP_USD));
        oracle.getPrice(FeedIds.XRP_USD);
    }

    function test_getPriceRevertsWhenFeedUnknown() public {
        vm.expectRevert();
        oracle.getPrice(FeedIds.crypto("NOPE/USD"));
    }

    function test_getQuoteXrpToUsdc() public view {
        // 500 XRP at 0.6248 == 312.40 USDC
        uint256 out = oracle.getQuote(FeedIds.XRP_USD, FeedIds.USDC_USD, 500e6, 6, 6);
        assertEq(out, 312.4e6);
    }

    function test_getQuoteAcrossDifferentTokenDecimals() public {
        // Same trade, but the destination token has 18 decimals.
        bytes21 feed = FeedIds.crypto("DAI/USD");
        ftso.setFeedNow(feed, 100_000, PRICE_DECIMALS);
        uint256 out = oracle.getQuote(FeedIds.XRP_USD, feed, 500e6, 6, 18);
        assertEq(out, 312.4e18);
    }

    function test_getQuoteRevertsOnZeroAmount() public {
        vm.expectRevert(PriceOracle.ZeroAmount.selector);
        oracle.getQuote(FeedIds.XRP_USD, FeedIds.USDC_USD, 0, 6, 6);
    }

    function test_getExchangeRateWad() public view {
        uint256 rate = oracle.getExchangeRateWad(FeedIds.XRP_USD, FeedIds.USDC_USD);
        assertEq(rate, 0.6248e18);
    }

    function test_isWithinSlippage() public view {
        assertTrue(oracle.isWithinSlippage(1000, 1000, 0), "exact match");
        assertTrue(oracle.isWithinSlippage(1000, 1200, 0), "more than expected is fine");
        assertTrue(oracle.isWithinSlippage(1000, 990, 100), "1% down at 1% tolerance");
        assertFalse(oracle.isWithinSlippage(1000, 989, 100), "beyond 1% tolerance");
        assertTrue(oracle.isWithinSlippage(1000, 0, 10_000), "100% tolerance accepts anything");
    }

    function test_slippageFloor() public view {
        assertEq(oracle.slippageFloor(1_000_000, 50), 995_000);
        assertEq(oracle.slippageFloor(1_000_000, 0), 1_000_000);
        assertEq(oracle.slippageFloor(1_000_000, 10_000), 0);
    }

    function test_getUsdValueWad() public view {
        assertEq(oracle.getUsdValueWad(FeedIds.XRP_USD, 500e6, 6), 312.4e18);
    }

    function test_onlyOwnerCanSetMaxPriceAge() public {
        vm.prank(attacker);
        vm.expectRevert();
        oracle.setMaxPriceAge(60);

        vm.prank(owner);
        oracle.setMaxPriceAge(60);
        assertEq(oracle.maxPriceAge(), 60);
    }

    function test_setMaxPriceAgeRejectsZero() public {
        vm.prank(owner);
        vm.expectRevert(PriceOracle.MaxPriceAgeZero.selector);
        oracle.setMaxPriceAge(0);
    }

    /// @dev Round-trip: quoting A->B then B->A must not create value.
    function testFuzz_quoteRoundTripDoesNotCreateValue(uint96 amount) public view {
        vm.assume(amount > 1e6 && amount < 1e15);
        uint256 usdcOut = oracle.getQuote(FeedIds.XRP_USD, FeedIds.USDC_USD, amount, 6, 6);
        vm.assume(usdcOut > 0);
        uint256 back = oracle.getQuote(FeedIds.USDC_USD, FeedIds.XRP_USD, usdcOut, 6, 6);
        assertLe(back, uint256(amount) + 2, "round trip must not mint value beyond rounding");
    }

    function testFuzz_slippageFloorNeverExceedsExpected(uint128 expected, uint16 bps) public view {
        assertLe(oracle.slippageFloor(expected, bps), expected);
    }
}
