// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

import {LiquidityPool} from "../src/LiquidityPool.sol";
import {PooledFxrpMinter} from "../src/adapters/PooledFxrpMinter.sol";
import {PriceOracle} from "../src/PriceOracle.sol";
import {IIntentManager, TokenConfig} from "../src/interfaces/IIntentManager.sol";
import {FeedIds} from "../src/libraries/FeedIds.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";

/// @notice Seeds every FXRP/<token> pool at the live FTSO rate and tops up the minter reserve.
///
/// @dev Seeding *at the oracle rate* matters: {IntentSettler} refuses any fill more than the
///      user's slippage tolerance below FTSO fair value, so a pool seeded at an arbitrary ratio
///      would reject every settlement until arbitrage repaired it.
///
/// @dev Environment:
///        PRIVATE_KEY        deployer/operator key
///        SEED_FXRP_PER_POOL FXRP side of each seed, in base units (default 200,000 FXRP)
///        MINTER_RESERVE     FXRP to park in the minter (default 2,000,000 FXRP)
///
/// @dev Usage:
///        forge script script/Seed.s.sol:Seed --rpc-url coston2 --broadcast --slow -vvv
contract Seed is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);

        string memory path = string.concat("deployments/", vm.toString(block.chainid), ".json");
        string memory json = vm.readFile(path);

        address managerAddr = vm.parseJsonAddress(json, ".intentManager");
        address minterAddr = vm.parseJsonAddress(json, ".minter");
        address oracleAddr = vm.parseJsonAddress(json, ".priceOracle");
        address fxrp = vm.parseJsonAddress(json, ".fxrp");
        bool usesFAssets = vm.parseJsonBool(json, ".usesFAssets");

        address[] memory tokens = vm.parseJsonAddressArray(json, ".tokenAddresses");
        address[] memory pools = vm.parseJsonAddressArray(json, ".tokenPools");

        uint256 seedPerPool = vm.envOr("SEED_FXRP_PER_POOL", uint256(200_000e6));
        uint256 minterReserve = vm.envOr("MINTER_RESERVE", uint256(2_000_000e6));

        PriceOracle oracle = PriceOracle(oracleAddr);
        IIntentManager manager = IIntentManager(managerAddr);

        vm.startBroadcast(deployerKey);

        for (uint256 i = 0; i < tokens.length; i++) {
            // A zero pool means the FAsset itself, which is delivered without an AMM hop.
            if (pools[i] == address(0)) continue;

            TokenConfig memory config = manager.getTokenConfig(tokens[i]);
            LiquidityPool pool = LiquidityPool(pools[i]);

            (uint256 reserve0,) = pool.getReserves();
            if (reserve0 > 0) {
                console2.log(string.concat("skip ", config.symbol, " (already seeded)"));
                continue;
            }

            uint256 quoteAmount =
                oracle.getQuote(FeedIds.XRP_USD, config.feedId, seedPerPool, 6, config.decimals);

            _ensureBalance(fxrp, deployer, seedPerPool);
            _ensureBalance(tokens[i], deployer, quoteAmount);

            IERC20(fxrp).approve(pools[i], seedPerPool);
            IERC20(tokens[i]).approve(pools[i], quoteAmount);
            pool.addLiquidity(seedPerPool, quoteAmount, 0, 0, deployer, block.timestamp + 1 hours);

            console2.log(string.concat("seeded FXRP/", config.symbol), seedPerPool, quoteAmount);
        }

        if (!usesFAssets) {
            uint256 held = IERC20(fxrp).balanceOf(minterAddr);
            if (held < minterReserve) {
                uint256 topUp = minterReserve - held;
                _ensureBalance(fxrp, deployer, topUp);
                IERC20(fxrp).approve(minterAddr, topUp);
                PooledFxrpMinter(minterAddr).fundReserve(topUp);
                console2.log("minter reserve topped up by", topUp);
            }
        }

        vm.stopBroadcast();
    }

    /// @dev Mints the shortfall when the token is our own MockERC20; otherwise asserts.
    function _ensureBalance(address token, address who, uint256 needed) internal {
        uint256 balance = IERC20(token).balanceOf(who);
        if (balance >= needed) return;

        uint256 shortfall = needed - balance;
        (bool ok,) = token.call(abi.encodeWithSelector(MockERC20.mint.selector, who, shortfall));
        require(
            ok,
            string.concat(
                "Seed: insufficient ", IERC20Metadata(token).symbol(), " and token is not mintable"
            )
        );
    }
}
