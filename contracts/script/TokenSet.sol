// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {FeedIds} from "../src/libraries/FeedIds.sol";

/// @notice The destination tokens FlareSwap offers, in one place.
///
/// @dev Shared by `Deploy` and `DeployLocal` so testnet and local devnet always expose the same
///      menu. Adding a destination is a single entry here plus liquidity — no contract change,
///      because `IntentManager.configureToken` and `IntentSettler.setPool` are already per-token.
///
///      Every destination needs an FTSO feed: `IntentSettler` prices the swap against it and
///      enforces the slippage floor, so a token without a feed cannot be listed.
library TokenSet {
    struct Spec {
        string symbol;
        string name;
        uint8 decimals;
        bytes21 feedId;
        /// @notice FXRP side of the initial pool seed, in FXRP base units (6 dp).
        uint256 seedFxrp;
        /// @notice True for the FAsset itself, which is delivered directly with no pool.
        bool isFAsset;
    }

    /// @notice Destination tokens, in the order the UI lists them.
    function all() internal pure returns (Spec[] memory specs) {
        specs = new Spec[](4);

        specs[0] = Spec({
            symbol: "USDC",
            name: "USD Coin",
            decimals: 6,
            feedId: FeedIds.USDC_USD,
            seedFxrp: 400_000e6,
            isFAsset: false
        });

        specs[1] = Spec({
            symbol: "USDT",
            name: "Tether USD",
            decimals: 6,
            feedId: FeedIds.USDT_USD,
            seedFxrp: 250_000e6,
            isFAsset: false
        });

        // 18 decimals on purpose: exercises the decimal normalisation in PriceOracle.getQuote
        // and IntentSettler._deliver against a non-6dp destination.
        specs[2] = Spec({
            symbol: "WFLR",
            name: "Wrapped Flare",
            decimals: 18,
            feedId: FeedIds.FLR_USD,
            seedFxrp: 150_000e6,
            isFAsset: false
        });

        // FXRP is a destination too — the settler short-circuits the AMM and delivers it
        // directly, so it needs no pool and no seed.
        specs[3] = Spec({
            symbol: "FXRP",
            name: "FAsset XRP",
            decimals: 6,
            feedId: FeedIds.XRP_USD,
            seedFxrp: 0,
            isFAsset: true
        });
    }

    /// @notice Number of destinations that require their own pool.
    function pooledCount() internal pure returns (uint256 count) {
        Spec[] memory specs = all();
        for (uint256 i = 0; i < specs.length; i++) {
            if (!specs[i].isFAsset) count++;
        }
    }
}
