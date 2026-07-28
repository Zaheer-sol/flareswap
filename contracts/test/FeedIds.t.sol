// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {Test} from "forge-std/Test.sol";
import {FeedIds} from "../src/libraries/FeedIds.sol";

/// @notice Guards the hard-coded feed ids against a typo — each constant is re-derived from its
///         human-readable name and compared. A wrong feed id would silently price swaps off the
///         wrong asset, so this is the cheapest high-value test in the suite.
contract FeedIdsTest is Test {
    function test_flrUsdMatchesPublishedId() public pure {
        // Published by Flare in the FTSOv2 feed table.
        assertEq(
            FeedIds.FLR_USD, bytes21(0x01464c522f55534400000000000000000000000000), "FLR/USD constant"
        );
        assertEq(FeedIds.crypto("FLR/USD"), FeedIds.FLR_USD, "FLR/USD derivation");
    }

    function test_xrpUsdDerivation() public pure {
        assertEq(FeedIds.crypto("XRP/USD"), FeedIds.XRP_USD);
    }

    function test_btcUsdDerivation() public pure {
        assertEq(FeedIds.crypto("BTC/USD"), FeedIds.BTC_USD);
    }

    function test_ethUsdDerivation() public pure {
        assertEq(FeedIds.crypto("ETH/USD"), FeedIds.ETH_USD);
    }

    function test_usdcUsdDerivation() public pure {
        assertEq(FeedIds.crypto("USDC/USD"), FeedIds.USDC_USD);
    }

    function test_usdtUsdDerivation() public pure {
        assertEq(FeedIds.crypto("USDT/USD"), FeedIds.USDT_USD);
    }

    function test_layoutIsCategoryThenAsciiThenZeroPadding() public pure {
        bytes21 id = FeedIds.XRP_USD;
        assertEq(uint8(id[0]), 0x01, "category byte");
        assertEq(id[1], bytes1("X"));
        assertEq(id[2], bytes1("R"));
        assertEq(id[3], bytes1("P"));
        assertEq(id[4], bytes1("/"));
        assertEq(id[5], bytes1("U"));
        assertEq(id[6], bytes1("S"));
        assertEq(id[7], bytes1("D"));
        for (uint256 i = 8; i < 21; i++) {
            assertEq(uint8(id[i]), 0, "padding must be zero");
        }
    }

    function test_distinctNamesProduceDistinctIds() public pure {
        assertTrue(FeedIds.XRP_USD != FeedIds.FLR_USD);
        assertTrue(FeedIds.USDC_USD != FeedIds.USDT_USD);
        assertTrue(FeedIds.crypto("BTC/USD") != FeedIds.crypto("BTC/EUR"));
    }

    function test_revertsOnOverlongName() public {
        vm.expectRevert(abi.encodeWithSelector(FeedIds.FeedNameTooLong.selector, uint256(21)));
        this.buildFeedId("012345678901234567890");
    }

    function buildFeedId(string calldata name) external pure returns (bytes21) {
        return FeedIds.crypto(name);
    }
}
