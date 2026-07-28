// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IFlareContractRegistry} from "./interfaces/IFlareContractRegistry.sol";
import {FtsoV2Reader} from "./libraries/FtsoV2Reader.sol";

/// @title  PriceOracle
/// @notice Thin, opinionated wrapper around FTSOv2.
/// @dev    Everything here is `view`, so the frontend can read quotes over `eth_call` and
///         {IntentSettler} can validate slippage inline without an extra transaction.
///
///         Three things this adds on top of a raw `getFeedById` call:
///           1. address resolution through the canonical FlareContractRegistry,
///           2. a staleness guard — a price older than `maxPriceAge` reverts instead of
///              silently pricing a swap off a dead feed,
///           3. decimal normalisation to 18 dp so cross-feed maths is uniform.
contract PriceOracle is Ownable {
    using FtsoV2Reader for address;

    /// @notice Canonical FlareContractRegistry — identical address on Flare, Songbird,
    ///         Coston and Coston2.
    address public constant CANONICAL_REGISTRY = 0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019;

    uint256 internal constant WAD = 1e18;
    uint256 internal constant BPS_DENOMINATOR = 10_000;
    int256 internal constant MAX_ABS_FEED_DECIMALS = 36;

    IFlareContractRegistry public immutable registry;

    /// @notice Maximum age of an FTSO value before {getPrice} reverts, in seconds.
    /// @dev FTSOv2 feeds update at block latency (~1.8s). 300s is ~166 missed rounds, which only
    ///      happens if the feed itself is down — exactly the case we want to fail closed on.
    uint256 public maxPriceAge = 300;

    event MaxPriceAgeUpdated(uint256 previous, uint256 current);

    error PriceStale(bytes21 feedId, uint64 feedTimestamp, uint256 nowTimestamp, uint256 maxAge);
    error PriceZero(bytes21 feedId);
    error FeedDecimalsOutOfRange(bytes21 feedId, int8 decimals);
    error FtsoV2NotRegistered();
    error ZeroAmount();
    error MaxPriceAgeZero();

    constructor(address registry_, address owner_) Ownable(owner_) {
        registry = IFlareContractRegistry(registry_ == address(0) ? CANONICAL_REGISTRY : registry_);
    }

    /* ------------------------------------------------------------------ */
    /*                               admin                                 */
    /* ------------------------------------------------------------------ */

    function setMaxPriceAge(uint256 newMaxPriceAge) external onlyOwner {
        if (newMaxPriceAge == 0) revert MaxPriceAgeZero();
        emit MaxPriceAgeUpdated(maxPriceAge, newMaxPriceAge);
        maxPriceAge = newMaxPriceAge;
    }

    /* ------------------------------------------------------------------ */
    /*                            resolution                               */
    /* ------------------------------------------------------------------ */

    /// @notice Current FTSOv2 address, resolved live so contract upgrades on Flare are picked up.
    function ftsoV2() public view returns (address addr) {
        addr = registry.getContractAddressByName("FtsoV2");
        if (addr == address(0)) revert FtsoV2NotRegistered();
    }

    /* ------------------------------------------------------------------ */
    /*                               prices                                */
    /* ------------------------------------------------------------------ */

    /// @notice Raw FTSOv2 feed value with its own decimals, staleness-checked.
    function getPrice(bytes21 feedId) public view returns (uint256 value, int8 decimals, uint64 timestamp) {
        (value, decimals, timestamp) = ftsoV2().readFeed(feedId);

        if (value == 0) revert PriceZero(feedId);
        if (int256(decimals) > MAX_ABS_FEED_DECIMALS || int256(decimals) < -MAX_ABS_FEED_DECIMALS) {
            revert FeedDecimalsOutOfRange(feedId, decimals);
        }
        // `timestamp` is the voting-round epoch; a value from the future would mean a broken feed.
        if (timestamp > block.timestamp || block.timestamp - timestamp > maxPriceAge) {
            revert PriceStale(feedId, timestamp, block.timestamp, maxPriceAge);
        }
    }

    /// @notice Feed value normalised to 18 decimals (USD per whole unit of the asset).
    function getPriceWad(bytes21 feedId) public view returns (uint256 priceWad, uint64 timestamp) {
        uint256 value;
        int8 decimals;
        (value, decimals, timestamp) = getPrice(feedId);
        priceWad = _toWad(value, decimals);
        if (priceWad == 0) revert PriceZero(feedId);
    }

    /// @notice USD value, in 18 decimals, of `amount` base units of a token.
    function getUsdValueWad(bytes21 feedId, uint256 amount, uint8 tokenDecimals)
        public
        view
        returns (uint256 usdWad)
    {
        (uint256 priceWad,) = getPriceWad(feedId);
        usdWad = Math.mulDiv(amount, priceWad, 10 ** tokenDecimals);
    }

    /* ------------------------------------------------------------------ */
    /*                               quotes                                */
    /* ------------------------------------------------------------------ */

    /// @notice Oracle-implied output for a swap, ignoring AMM curve and fees.
    /// @dev This is the *fair value* reference. {IntentSettler} compares the AMM's realised
    ///      output against it to bound price impact and pool manipulation, and the frontend
    ///      shows it as the headline exchange rate.
    /// @param sourceFeedId   FTSO feed for the input asset (e.g. XRP/USD).
    /// @param destFeedId     FTSO feed for the output asset (e.g. USDC/USD).
    /// @param sourceAmount   Input amount in `sourceDecimals` base units.
    /// @param sourceDecimals Decimals of the input asset (6 for XRP drops).
    /// @param destDecimals   Decimals of the output token.
    /// @return outputAmount  Expected output in `destDecimals` base units.
    function getQuote(
        bytes21 sourceFeedId,
        bytes21 destFeedId,
        uint256 sourceAmount,
        uint8 sourceDecimals,
        uint8 destDecimals
    ) public view returns (uint256 outputAmount) {
        if (sourceAmount == 0) revert ZeroAmount();

        (uint256 sourcePriceWad,) = getPriceWad(sourceFeedId);
        (uint256 destPriceWad,) = getPriceWad(destFeedId);

        // usdWad = sourceAmount * sourcePrice / 10**sourceDecimals
        uint256 usdWad = Math.mulDiv(sourceAmount, sourcePriceWad, 10 ** sourceDecimals);
        // out = usdWad * 10**destDecimals / destPrice
        outputAmount = Math.mulDiv(usdWad, 10 ** destDecimals, destPriceWad);
    }

    /// @notice Exchange rate in 18 decimals: how many whole dest units one whole source unit buys.
    function getExchangeRateWad(bytes21 sourceFeedId, bytes21 destFeedId)
        public
        view
        returns (uint256 rateWad)
    {
        (uint256 sourcePriceWad,) = getPriceWad(sourceFeedId);
        (uint256 destPriceWad,) = getPriceWad(destFeedId);
        rateWad = Math.mulDiv(sourcePriceWad, WAD, destPriceWad);
    }

    /* ------------------------------------------------------------------ */
    /*                              slippage                               */
    /* ------------------------------------------------------------------ */

    /// @notice True when `actualOutput` is no worse than `maxSlippageBps` below `expectedOutput`.
    /// @dev Receiving *more* than expected is always fine, so this is a one-sided bound.
    function isWithinSlippage(uint256 expectedOutput, uint256 actualOutput, uint16 maxSlippageBps)
        public
        pure
        returns (bool)
    {
        if (actualOutput >= expectedOutput) return true;
        return actualOutput >= slippageFloor(expectedOutput, maxSlippageBps);
    }

    /// @notice The minimum acceptable output for `expectedOutput` at `maxSlippageBps`.
    function slippageFloor(uint256 expectedOutput, uint16 maxSlippageBps) public pure returns (uint256) {
        if (maxSlippageBps >= BPS_DENOMINATOR) return 0;
        return Math.mulDiv(expectedOutput, BPS_DENOMINATOR - maxSlippageBps, BPS_DENOMINATOR);
    }

    /* ------------------------------------------------------------------ */
    /*                              internals                              */
    /* ------------------------------------------------------------------ */

    /// @dev Rescales `value` from `decimals` to 18 decimals. FTSO decimals are signed: a
    ///      negative value means the feed reports in units larger than one (rare, but legal).
    function _toWad(uint256 value, int8 decimals) internal pure returns (uint256) {
        int256 exponent = 18 - int256(decimals);
        if (exponent >= 0) {
            return value * (10 ** uint256(exponent));
        }
        return value / (10 ** uint256(-exponent));
    }
}
