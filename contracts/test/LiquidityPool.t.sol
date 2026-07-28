// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {BaseTest} from "./Base.t.sol";
import {LiquidityPool} from "../src/LiquidityPool.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";

contract LiquidityPoolTest is BaseTest {
    address internal lp2 = makeAddr("lp2");
    address internal trader = makeAddr("trader");

    function setUp() public override {
        super.setUp();
        fxrp.mint(trader, 1_000_000e6);
        usdc.mint(trader, 1_000_000e6);
        vm.startPrank(trader);
        fxrp.approve(address(pool), type(uint256).max);
        usdc.approve(address(pool), type(uint256).max);
        vm.stopPrank();
    }

    /* ------------------------------ liquidity ------------------------------- */

    function test_initialLiquidityLocksMinimumShares() public view {
        assertEq(pool.reserve0(), POOL_FXRP);
        assertEq(pool.reserve1(), POOL_USDC);
        assertEq(pool.balanceOf(0x000000000000000000000000000000000000dEaD), pool.MINIMUM_LIQUIDITY());
        assertGt(pool.balanceOf(lp), 0);
        assertEq(pool.totalSupply(), pool.balanceOf(lp) + pool.MINIMUM_LIQUIDITY());
    }

    function test_addLiquidityRebalancesToPoolRatio() public {
        // Offer a lopsided deposit: 1000 FXRP but 10,000 USDC. Only ~624.8 USDC is needed.
        fxrp.mint(lp2, 1_000e6);
        usdc.mint(lp2, 10_000e6);

        vm.startPrank(lp2);
        fxrp.approve(address(pool), type(uint256).max);
        usdc.approve(address(pool), type(uint256).max);
        (uint256 a0, uint256 a1,) = pool.addLiquidity(1_000e6, 10_000e6, 0, 0, lp2, 0);
        vm.stopPrank();

        assertEq(a0, 1_000e6, "full token0 side taken");
        assertEq(a1, 624.8e6, "token1 side rebalanced to pool ratio");
        // Unused USDC stayed with the provider.
        assertEq(usdc.balanceOf(lp2), 10_000e6 - 624.8e6);
    }

    function test_addLiquidityHonoursMinimums() public {
        fxrp.mint(lp2, 1_000e6);
        usdc.mint(lp2, 10_000e6);
        vm.startPrank(lp2);
        fxrp.approve(address(pool), type(uint256).max);
        usdc.approve(address(pool), type(uint256).max);
        vm.expectRevert(
            abi.encodeWithSelector(LiquidityPool.InsufficientAmount1.selector, uint256(624.8e6), uint256(700e6))
        );
        pool.addLiquidity(1_000e6, 10_000e6, 0, 700e6, lp2, 0);
        vm.stopPrank();
    }

    function test_removeLiquidityReturnsProportionalShare() public {
        uint256 shares = pool.balanceOf(lp);
        uint256 half = shares / 2;

        vm.prank(lp);
        (uint256 a0, uint256 a1) = pool.removeLiquidity(half, 0, 0, lp, 0);

        assertApproxEqRel(a0, POOL_FXRP / 2, 1e15, "half of reserve0");
        assertApproxEqRel(a1, POOL_USDC / 2, 1e15, "half of reserve1");
        assertEq(fxrp.balanceOf(lp), a0);
        assertEq(usdc.balanceOf(lp), a1);
    }

    function test_removeLiquidityCannotDrainBelowMinimum() public {
        uint256 shares = pool.balanceOf(lp);
        vm.prank(lp);
        pool.removeLiquidity(shares, 0, 0, lp, 0);
        // MINIMUM_LIQUIDITY shares remain locked, so reserves never hit zero.
        assertEq(pool.totalSupply(), pool.MINIMUM_LIQUIDITY());
        assertGt(pool.reserve0(), 0);
        assertGt(pool.reserve1(), 0);
    }

    /* --------------------------------- swap --------------------------------- */

    function test_swapMatchesGetAmountOut() public {
        uint256 quoted = pool.getAmountOut(address(fxrp), 1_000e6);
        vm.prank(trader);
        uint256 out = pool.swap(address(fxrp), 1_000e6, 0, trader, 0);
        assertEq(out, quoted, "quote must match execution");
        assertGt(out, 0);
    }

    function test_swapChargesTheConfiguredFee() public {
        // With huge reserves relative to the trade, output approaches in * price * (1 - fee).
        uint256 out = pool.getAmountOut(address(fxrp), 100e6);
        uint256 feelessIdeal = (100e6 * POOL_USDC) / POOL_FXRP; // 62.48 USDC
        assertLt(out, feelessIdeal);
        assertApproxEqRel(out, (feelessIdeal * 9970) / 10_000, 1e15, "~30bps fee");
    }

    function test_swapRespectsMinAmountOut() public {
        uint256 quoted = pool.getAmountOut(address(fxrp), 1_000e6);
        vm.prank(trader);
        vm.expectRevert(
            abi.encodeWithSelector(LiquidityPool.InsufficientOutputAmount.selector, quoted, quoted + 1)
        );
        pool.swap(address(fxrp), 1_000e6, quoted + 1, trader, 0);
    }

    function test_swapRevertsOnUnknownToken() public {
        MockERC20 other = new MockERC20("Other", "OTH", 18);
        vm.prank(trader);
        vm.expectRevert(abi.encodeWithSelector(LiquidityPool.UnknownToken.selector, address(other)));
        pool.swap(address(other), 1e18, 0, trader, 0);
    }

    function test_swapRevertsAfterDeadline() public {
        // Written as a literal, not `block.timestamp`: under via-IR the optimizer may fold a
        // timestamp read across the `vm.warp` cheatcode, which would silently pick up the new
        // time and defeat the test.
        uint256 deadline = START_TIME;
        vm.warp(START_TIME + 1);
        vm.prank(trader);
        vm.expectRevert(abi.encodeWithSelector(LiquidityPool.Expired.selector, deadline));
        pool.swap(address(fxrp), 1_000e6, 0, trader, deadline);
    }

    function test_swapBothDirections() public {
        vm.startPrank(trader);
        uint256 usdcOut = pool.swap(address(fxrp), 1_000e6, 0, trader, 0);
        uint256 fxrpOut = pool.swap(address(usdc), usdcOut, 0, trader, 0);
        vm.stopPrank();
        // Two 30bps fees means the round trip must lose value.
        assertLt(fxrpOut, 1_000e6, "round trip cannot be profitable");
        assertApproxEqRel(fxrpOut, (1_000e6 * 9940) / 10_000, 2e15, "~60bps total");
    }

    /* ------------------------------ accounting ------------------------------ */

    function test_donationDoesNotMovePrice() public {
        uint256 priceBefore = pool.spotPrice0In1();
        uint256 quoteBefore = pool.getAmountOut(address(fxrp), 1_000e6);

        // Donate 100k USDC straight to the pool.
        usdc.mint(address(pool), 100_000e6);

        assertEq(pool.spotPrice0In1(), priceBefore, "donation must not reprice the pool");
        assertEq(pool.getAmountOut(address(fxrp), 1_000e6), quoteBefore, "quote unchanged");
    }

    function test_skimSweepsUntrackedSurplus() public {
        usdc.mint(address(pool), 12_345e6);
        vm.prank(owner);
        pool.skim(owner);
        assertEq(usdc.balanceOf(owner), 12_345e6);
        assertEq(usdc.balanceOf(address(pool)), pool.reserve1());
    }

    function test_onlyOwnerCanSkim() public {
        vm.prank(attacker);
        vm.expectRevert();
        pool.skim(attacker);
    }

    function test_setSwapFeeIsCapped() public {
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(LiquidityPool.SwapFeeTooHigh.selector, uint16(101), uint16(100)));
        pool.setSwapFeeBps(101);

        vm.prank(owner);
        pool.setSwapFeeBps(100);
        assertEq(pool.swapFeeBps(), 100);
    }

    function test_priceImpactGrowsWithSize() public view {
        uint256 small = pool.priceImpactBps(address(fxrp), 1_000e6);
        uint256 large = pool.priceImpactBps(address(fxrp), 100_000e6);
        assertLt(small, large);
        assertGt(large, 0);
    }

    function test_getAmountInRoundTripsWithGetAmountOut() public view {
        uint256 targetOut = 1_000e6;
        uint256 amountIn = pool.getAmountIn(address(fxrp), targetOut);
        assertGe(pool.getAmountOut(address(fxrp), amountIn), targetOut, "must cover the target");
    }

    function test_previewAddLiquidityMatchesExecution() public {
        fxrp.mint(lp2, 5_000e6);
        usdc.mint(lp2, 5_000e6);
        (uint256 p0, uint256 p1, uint256 pShares) = pool.previewAddLiquidity(5_000e6, 5_000e6);

        vm.startPrank(lp2);
        fxrp.approve(address(pool), type(uint256).max);
        usdc.approve(address(pool), type(uint256).max);
        (uint256 a0, uint256 a1, uint256 shares) = pool.addLiquidity(5_000e6, 5_000e6, 0, 0, lp2, 0);
        vm.stopPrank();

        assertEq(a0, p0);
        assertEq(a1, p1);
        assertEq(shares, pShares);
    }

    /* -------------------------------- fuzz ---------------------------------- */

    /// @dev The core AMM invariant: a swap must never decrease k.
    function testFuzz_swapNeverDecreasesK(uint96 amountIn, bool zeroForOne) public {
        amountIn = uint96(bound(amountIn, 1e6, 100_000e6));
        address tokenIn = zeroForOne ? address(fxrp) : address(usdc);

        uint256 kBefore = pool.reserve0() * pool.reserve1();
        vm.prank(trader);
        pool.swap(tokenIn, amountIn, 0, trader, 0);
        uint256 kAfter = pool.reserve0() * pool.reserve1();

        assertGe(kAfter, kBefore, "constant product must not shrink");
    }

    /// @dev Reserves must always equal the pool's own token balances when nobody has donated.
    function testFuzz_reservesTrackBalances(uint96 amountIn) public {
        amountIn = uint96(bound(amountIn, 1e6, 100_000e6));
        vm.prank(trader);
        pool.swap(address(fxrp), amountIn, 0, trader, 0);
        assertEq(pool.reserve0(), fxrp.balanceOf(address(pool)));
        assertEq(pool.reserve1(), usdc.balanceOf(address(pool)));
    }

    /// @dev Adding then immediately removing liquidity must never be profitable.
    function testFuzz_addRemoveRoundTripIsNotProfitable(uint96 amount0) public {
        amount0 = uint96(bound(amount0, 1e6, 100_000e6));
        uint256 amount1 = (uint256(amount0) * POOL_USDC) / POOL_FXRP + 1e6;

        fxrp.mint(lp2, amount0);
        usdc.mint(lp2, amount1);

        vm.startPrank(lp2);
        fxrp.approve(address(pool), type(uint256).max);
        usdc.approve(address(pool), type(uint256).max);
        (uint256 in0, uint256 in1, uint256 shares) = pool.addLiquidity(amount0, amount1, 0, 0, lp2, 0);
        (uint256 out0, uint256 out1) = pool.removeLiquidity(shares, 0, 0, lp2, 0);
        vm.stopPrank();

        assertLe(out0, in0, "cannot extract more token0 than deposited");
        assertLe(out1, in1, "cannot extract more token1 than deposited");
    }
}
