// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title  LiquidityPool
/// @notice Constant-product (x*y=k) AMM for the FXRP/USDC pair, with ERC-20 LP shares.
///
/// @dev    Design notes that differ from a stock Uniswap-V2 fork:
///
///         * **Reserves are explicit, not balance-derived.** `reserve0`/`reserve1` are updated
///           from measured transfer deltas. A direct token donation to this contract therefore
///           cannot move the price — it just sits there until {skim} sweeps it. That closes the
///           donation/inflation vector on the first depositor and keeps {IntentSettler}'s
///           FTSO-based slippage bound meaningful.
///         * **Transfer deltas, not requested amounts.** Every pull measures `balanceOf` before
///           and after, so a fee-on-transfer or rebasing token can never over-credit a swapper.
///         * MINIMUM_LIQUIDITY shares are burned on the first deposit so `totalSupply` can never
///           return to zero while reserves are non-zero.
contract LiquidityPool is ERC20, ReentrancyGuard, Ownable2Step {
    using SafeERC20 for IERC20;

    uint256 public constant MINIMUM_LIQUIDITY = 1_000;
    uint16 public constant MAX_SWAP_FEE_BPS = 100; // 1.00% ceiling, enforced on setSwapFeeBps
    uint256 private constant BPS_DENOMINATOR = 10_000;
    address private constant BURN_ADDRESS = 0x000000000000000000000000000000000000dEaD;

    IERC20 public immutable token0;
    IERC20 public immutable token1;

    uint256 public reserve0;
    uint256 public reserve1;

    /// @notice Swap fee retained by LPs, in basis points of the input amount.
    uint16 public swapFeeBps = 30;

    /// @notice Lifetime input volume per token, for the /pool and /explorer dashboards.
    uint256 public cumulativeVolume0;
    uint256 public cumulativeVolume1;
    uint256 public swapCount;

    event LiquidityAdded(
        address indexed provider, address indexed to, uint256 amount0, uint256 amount1, uint256 shares
    );
    event LiquidityRemoved(
        address indexed provider, address indexed to, uint256 amount0, uint256 amount1, uint256 shares
    );
    event Swapped(
        address indexed sender,
        address indexed to,
        address indexed tokenIn,
        uint256 amountIn,
        uint256 amountOut
    );
    event Sync(uint256 reserve0, uint256 reserve1);
    event SwapFeeUpdated(uint16 previous, uint16 current);
    event Skimmed(address indexed to, uint256 amount0, uint256 amount1);

    error IdenticalTokens();
    error ZeroAddress();
    error ZeroAmount();
    error InsufficientLiquidityMinted();
    error InsufficientLiquidityBurned();
    error InsufficientLiquidity();
    error InsufficientOutputAmount(uint256 amountOut, uint256 minAmountOut);
    error InsufficientAmount0(uint256 amount0, uint256 min0);
    error InsufficientAmount1(uint256 amount1, uint256 min1);
    error UnknownToken(address token);
    error SwapFeeTooHigh(uint16 bps, uint16 maxBps);
    error Expired(uint256 deadline);

    modifier ensure(uint256 deadline) {
        if (deadline != 0 && block.timestamp > deadline) revert Expired(deadline);
        _;
    }

    constructor(address token0_, address token1_, address owner_, string memory name_, string memory symbol_)
        ERC20(name_, symbol_)
        Ownable(owner_)
    {
        if (token0_ == address(0) || token1_ == address(0)) revert ZeroAddress();
        if (token0_ == token1_) revert IdenticalTokens();
        token0 = IERC20(token0_);
        token1 = IERC20(token1_);
    }

    /* ------------------------------------------------------------------ */
    /*                               admin                                 */
    /* ------------------------------------------------------------------ */

    function setSwapFeeBps(uint16 newFeeBps) external onlyOwner {
        if (newFeeBps > MAX_SWAP_FEE_BPS) revert SwapFeeTooHigh(newFeeBps, MAX_SWAP_FEE_BPS);
        emit SwapFeeUpdated(swapFeeBps, newFeeBps);
        swapFeeBps = newFeeBps;
    }

    /// @notice Sends any balance held above the tracked reserves to `to`.
    /// @dev The counterpart to explicit reserve accounting: donations and fee-on-transfer dust
    ///      accumulate as an untracked surplus rather than silently repricing the pool.
    function skim(address to) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        uint256 surplus0 = token0.balanceOf(address(this)) - reserve0;
        uint256 surplus1 = token1.balanceOf(address(this)) - reserve1;
        if (surplus0 > 0) token0.safeTransfer(to, surplus0);
        if (surplus1 > 0) token1.safeTransfer(to, surplus1);
        emit Skimmed(to, surplus0, surplus1);
    }

    /* ------------------------------------------------------------------ */
    /*                             liquidity                               */
    /* ------------------------------------------------------------------ */

    /// @notice Deposits both tokens and mints LP shares to `to`.
    /// @dev On a non-empty pool the deposit is rebalanced to the current reserve ratio, and the
    ///      unused remainder of the larger side is simply never pulled from the caller.
    /// @return amount0 Amount of `token0` actually taken.
    /// @return amount1 Amount of `token1` actually taken.
    /// @return shares  LP shares minted.
    function addLiquidity(
        uint256 amount0Desired,
        uint256 amount1Desired,
        uint256 amount0Min,
        uint256 amount1Min,
        address to,
        uint256 deadline
    ) external nonReentrant ensure(deadline) returns (uint256 amount0, uint256 amount1, uint256 shares) {
        if (to == address(0)) revert ZeroAddress();
        if (amount0Desired == 0 || amount1Desired == 0) revert ZeroAmount();

        (uint256 r0, uint256 r1) = (reserve0, reserve1);

        if (r0 == 0 || r1 == 0) {
            (amount0, amount1) = (amount0Desired, amount1Desired);
        } else {
            uint256 amount1Optimal = Math.mulDiv(amount0Desired, r1, r0);
            if (amount1Optimal <= amount1Desired) {
                if (amount1Optimal < amount1Min) revert InsufficientAmount1(amount1Optimal, amount1Min);
                (amount0, amount1) = (amount0Desired, amount1Optimal);
            } else {
                uint256 amount0Optimal = Math.mulDiv(amount1Desired, r0, r1);
                if (amount0Optimal < amount0Min) revert InsufficientAmount0(amount0Optimal, amount0Min);
                (amount0, amount1) = (amount0Optimal, amount1Desired);
            }
        }

        amount0 = _pull(token0, msg.sender, amount0);
        amount1 = _pull(token1, msg.sender, amount1);
        if (amount0 == 0 || amount1 == 0) revert ZeroAmount();

        uint256 supply = totalSupply();
        if (supply == 0) {
            uint256 initial = Math.sqrt(amount0 * amount1);
            if (initial <= MINIMUM_LIQUIDITY) revert InsufficientLiquidityMinted();
            shares = initial - MINIMUM_LIQUIDITY;
            // Permanently locked so `totalSupply` can never round-trip to zero.
            _mint(BURN_ADDRESS, MINIMUM_LIQUIDITY);
        } else {
            shares = Math.min(Math.mulDiv(amount0, supply, r0), Math.mulDiv(amount1, supply, r1));
        }
        if (shares == 0) revert InsufficientLiquidityMinted();

        reserve0 = r0 + amount0;
        reserve1 = r1 + amount1;

        _mint(to, shares);
        emit LiquidityAdded(msg.sender, to, amount0, amount1, shares);
        emit Sync(reserve0, reserve1);
    }

    /// @notice Burns LP shares and returns the proportional share of both reserves.
    function removeLiquidity(
        uint256 shares,
        uint256 amount0Min,
        uint256 amount1Min,
        address to,
        uint256 deadline
    ) external nonReentrant ensure(deadline) returns (uint256 amount0, uint256 amount1) {
        if (to == address(0)) revert ZeroAddress();
        if (shares == 0) revert ZeroAmount();

        uint256 supply = totalSupply();
        amount0 = Math.mulDiv(shares, reserve0, supply);
        amount1 = Math.mulDiv(shares, reserve1, supply);
        if (amount0 == 0 || amount1 == 0) revert InsufficientLiquidityBurned();
        if (amount0 < amount0Min) revert InsufficientAmount0(amount0, amount0Min);
        if (amount1 < amount1Min) revert InsufficientAmount1(amount1, amount1Min);

        // Burn first: state is settled before any token callback can re-enter.
        _burn(msg.sender, shares);
        reserve0 -= amount0;
        reserve1 -= amount1;

        token0.safeTransfer(to, amount0);
        token1.safeTransfer(to, amount1);

        emit LiquidityRemoved(msg.sender, to, amount0, amount1, shares);
        emit Sync(reserve0, reserve1);
    }

    /* ------------------------------------------------------------------ */
    /*                                swap                                 */
    /* ------------------------------------------------------------------ */

    /// @notice Swaps `amountIn` of `tokenIn` for the other token along the constant-product curve.
    /// @param minAmountOut Reverts if the realised output is below this. {IntentSettler} passes
    ///        the stricter of the user's `minOutputAmount` and the FTSO slippage floor.
    function swap(address tokenIn, uint256 amountIn, uint256 minAmountOut, address to, uint256 deadline)
        external
        nonReentrant
        ensure(deadline)
        returns (uint256 amountOut)
    {
        if (to == address(0)) revert ZeroAddress();
        if (amountIn == 0) revert ZeroAmount();
        bool zeroForOne = _isZeroForOne(tokenIn);

        (uint256 reserveIn, uint256 reserveOut) = zeroForOne ? (reserve0, reserve1) : (reserve1, reserve0);
        if (reserveIn == 0 || reserveOut == 0) revert InsufficientLiquidity();

        IERC20 inToken = zeroForOne ? token0 : token1;
        IERC20 outToken = zeroForOne ? token1 : token0;

        uint256 received = _pull(inToken, msg.sender, amountIn);
        amountOut = _amountOut(received, reserveIn, reserveOut);

        if (amountOut == 0) revert InsufficientOutputAmount(0, minAmountOut);
        if (amountOut < minAmountOut) revert InsufficientOutputAmount(amountOut, minAmountOut);
        // Strict: the curve can never fully drain the output reserve, but guard the invariant.
        if (amountOut >= reserveOut) revert InsufficientLiquidity();

        if (zeroForOne) {
            reserve0 = reserveIn + received;
            reserve1 = reserveOut - amountOut;
            cumulativeVolume0 += received;
        } else {
            reserve1 = reserveIn + received;
            reserve0 = reserveOut - amountOut;
            cumulativeVolume1 += received;
        }
        swapCount++;

        outToken.safeTransfer(to, amountOut);

        emit Swapped(msg.sender, to, address(inToken), received, amountOut);
        emit Sync(reserve0, reserve1);
    }

    /* ------------------------------------------------------------------ */
    /*                                views                                */
    /* ------------------------------------------------------------------ */

    function getReserves() external view returns (uint256 r0, uint256 r1) {
        return (reserve0, reserve1);
    }

    /// @notice Output for `amountIn` of `tokenIn` at the current reserves, fee included.
    function getAmountOut(address tokenIn, uint256 amountIn) public view returns (uint256) {
        bool zeroForOne = _isZeroForOne(tokenIn);
        (uint256 reserveIn, uint256 reserveOut) = zeroForOne ? (reserve0, reserve1) : (reserve1, reserve0);
        if (reserveIn == 0 || reserveOut == 0 || amountIn == 0) return 0;
        return _amountOut(amountIn, reserveIn, reserveOut);
    }

    /// @notice Input of `tokenIn` required to receive exactly `amountOut` of the other token.
    function getAmountIn(address tokenIn, uint256 amountOut) external view returns (uint256) {
        bool zeroForOne = _isZeroForOne(tokenIn);
        (uint256 reserveIn, uint256 reserveOut) = zeroForOne ? (reserve0, reserve1) : (reserve1, reserve0);
        if (reserveIn == 0 || reserveOut == 0 || amountOut == 0 || amountOut >= reserveOut) return 0;
        uint256 numerator = reserveIn * amountOut * BPS_DENOMINATOR;
        uint256 denominator = (reserveOut - amountOut) * (BPS_DENOMINATOR - swapFeeBps);
        return (numerator / denominator) + 1;
    }

    /// @notice Marginal (zero-size) price of token0 in token1, scaled by 1e18.
    function spotPrice0In1() external view returns (uint256) {
        if (reserve0 == 0) return 0;
        return Math.mulDiv(reserve1, 1e18, reserve0);
    }

    /// @notice Price impact of a swap in basis points, relative to the marginal price.
    function priceImpactBps(address tokenIn, uint256 amountIn) external view returns (uint256) {
        bool zeroForOne = _isZeroForOne(tokenIn);
        (uint256 reserveIn, uint256 reserveOut) = zeroForOne ? (reserve0, reserve1) : (reserve1, reserve0);
        if (reserveIn == 0 || reserveOut == 0 || amountIn == 0) return 0;

        uint256 idealOut = Math.mulDiv(amountIn, reserveOut, reserveIn);
        uint256 realOut = _amountOut(amountIn, reserveIn, reserveOut);
        if (realOut >= idealOut) return 0;
        return Math.mulDiv(idealOut - realOut, BPS_DENOMINATOR, idealOut);
    }

    /// @notice Shares that would be minted for a balanced deposit, for UI previews.
    function previewAddLiquidity(uint256 amount0Desired, uint256 amount1Desired)
        external
        view
        returns (uint256 amount0, uint256 amount1, uint256 shares)
    {
        (uint256 r0, uint256 r1) = (reserve0, reserve1);
        if (r0 == 0 || r1 == 0) {
            (amount0, amount1) = (amount0Desired, amount1Desired);
            uint256 initial = Math.sqrt(amount0 * amount1);
            shares = initial > MINIMUM_LIQUIDITY ? initial - MINIMUM_LIQUIDITY : 0;
            return (amount0, amount1, shares);
        }
        uint256 amount1Optimal = Math.mulDiv(amount0Desired, r1, r0);
        if (amount1Optimal <= amount1Desired) {
            (amount0, amount1) = (amount0Desired, amount1Optimal);
        } else {
            (amount0, amount1) = (Math.mulDiv(amount1Desired, r0, r1), amount1Desired);
        }
        uint256 supply = totalSupply();
        shares = Math.min(Math.mulDiv(amount0, supply, r0), Math.mulDiv(amount1, supply, r1));
    }

    /// @notice Tokens returned for burning `shares`, for UI previews.
    function previewRemoveLiquidity(uint256 shares)
        external
        view
        returns (uint256 amount0, uint256 amount1)
    {
        uint256 supply = totalSupply();
        if (supply == 0) return (0, 0);
        amount0 = Math.mulDiv(shares, reserve0, supply);
        amount1 = Math.mulDiv(shares, reserve1, supply);
    }

    /* ------------------------------------------------------------------ */
    /*                              internals                              */
    /* ------------------------------------------------------------------ */

    function _isZeroForOne(address tokenIn) private view returns (bool) {
        if (tokenIn == address(token0)) return true;
        if (tokenIn == address(token1)) return false;
        revert UnknownToken(tokenIn);
    }

    /// @dev Constant product with the fee taken off the input:
    ///      out = (in * (1 - f) * reserveOut) / (reserveIn + in * (1 - f))
    function _amountOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut)
        private
        view
        returns (uint256)
    {
        uint256 amountInAfterFee = amountIn * (BPS_DENOMINATOR - swapFeeBps);
        uint256 numerator = amountInAfterFee * reserveOut;
        uint256 denominator = reserveIn * BPS_DENOMINATOR + amountInAfterFee;
        return numerator / denominator;
    }

    /// @dev Pulls `amount` and returns what actually arrived, so fee-on-transfer tokens are
    ///      credited at their true value.
    function _pull(IERC20 token, address from, uint256 amount) private returns (uint256 received) {
        uint256 balanceBefore = token.balanceOf(address(this));
        token.safeTransferFrom(from, address(this), amount);
        received = token.balanceOf(address(this)) - balanceBefore;
    }
}
