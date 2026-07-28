// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

import {IntentManager} from "../src/IntentManager.sol";
import {IntentSettler} from "../src/IntentSettler.sol";
import {PriceOracle} from "../src/PriceOracle.sol";
import {LiquidityPool} from "../src/LiquidityPool.sol";
import {PooledFxrpMinter} from "../src/adapters/PooledFxrpMinter.sol";
import {FeedIds} from "../src/libraries/FeedIds.sol";
import {SourceChainConfig, TokenConfig} from "../src/interfaces/IIntentManager.sol";

import {MockERC20} from "../src/mocks/MockERC20.sol";
import {MockFtsoV2} from "../src/mocks/MockFtsoV2.sol";
import {MockFdcVerification} from "../src/mocks/MockFdcVerification.sol";
import {MockFlareContractRegistry} from "../src/mocks/MockFlareContractRegistry.sol";

import {TokenSet} from "./TokenSet.sol";

/// @notice Full local stack on Anvil, including stand-ins for the Flare protocols.
///
/// @dev Coston2 is the real target, but it needs an FDC verifier API key, a funded operator and
///      a live XRPL testnet deposit — none of which belong in a "clone and run it" loop. This
///      deploys the same contracts against mocked FTSOv2/FDC/registry so the backend, the
///      frontend and the settlement path can all be exercised offline. The only substituted
///      pieces are the three Flare protocols themselves.
///
/// @dev Usage:
///        anvil &
///        forge script script/DeployLocal.s.sol:DeployLocal \
///          --rpc-url http://127.0.0.1:8545 --broadcast --slow
contract DeployLocal is Script {
    uint8 internal constant CHAIN_XRPL = 0;
    uint8 internal constant XRP_DECIMALS = 6;

    /// @dev Anvil's first account.
    uint256 internal constant DEFAULT_KEY =
        0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;

    string internal constant XRPL_DEPOSIT_ADDRESS = "rFLARESWAPlocalDevVault1234567890";

    uint256 internal constant MINTER_RESERVE = 3_000_000e6;

    // Written by _configureTokens, read by _write.
    address[] internal tokenAddresses;
    string[] internal tokenSymbols;
    uint256[] internal tokenDecimals;
    address[] internal tokenPools;

    function run() external {
        uint256 deployerKey = vm.envOr("PRIVATE_KEY", DEFAULT_KEY);
        address deployer = vm.addr(deployerKey);

        vm.startBroadcast(deployerKey);

        /* ------------------------- mocked Flare stack ------------------------- */

        MockFlareContractRegistry registry = new MockFlareContractRegistry();
        MockFtsoV2 ftso = new MockFtsoV2();
        MockFdcVerification fdc = new MockFdcVerification();

        registry.setContractAddress("FtsoV2", address(ftso));
        registry.setContractAddress("FdcVerification", address(fdc));

        // Seed realistic prices. `setFeedNow` stamps them at the current block timestamp, so
        // PriceOracle's 300s staleness guard is satisfied until the chain idles.
        ftso.setFeedNow(FeedIds.XRP_USD, 62_480, 5); // $0.62480
        ftso.setFeedNow(FeedIds.USDC_USD, 100_000, 5); // $1.00000
        ftso.setFeedNow(FeedIds.USDT_USD, 99_980, 5); // $0.99980
        ftso.setFeedNow(FeedIds.FLR_USD, 2_150, 5); // $0.02150
        ftso.setFeedNow(FeedIds.BTC_USD, 9_500_000_000, 5); // $95,000
        ftso.setFeedNow(FeedIds.ETH_USD, 320_000_000, 5); // $3,200

        /* -------------------------------- core -------------------------------- */

        MockERC20 fxrp = new MockERC20("FAsset XRP (local)", "FXRP", 6);

        IntentManager manager = new IntentManager(deployer);
        PriceOracle oracle = new PriceOracle(address(registry), deployer);
        PooledFxrpMinter minter = new PooledFxrpMinter(address(fxrp), XRP_DECIMALS, deployer);
        IntentSettler settler =
            new IntentSettler(address(manager), address(oracle), address(registry), deployer);

        manager.setAuthorized(address(settler), true);
        manager.setAuthorized(deployer, true);

        manager.configureSourceChain(
            CHAIN_XRPL,
            SourceChainConfig({
                enabled: true,
                decimals: XRP_DECIMALS,
                feedId: FeedIds.XRP_USD,
                sourceId: bytes32("testXRP"),
                depositAddressHash: keccak256(bytes(XRPL_DEPOSIT_ADDRESS)),
                name: "XRPL",
                symbol: "XRP",
                depositAddress: XRPL_DEPOSIT_ADDRESS
            }),
            1e6,
            1_000_000e6
        );

        minter.setAuthorized(address(settler), true);
        settler.setMinter(address(minter));
        settler.setProtocolFee(30, deployer);
        settler.setRelayer(deployer, true);

        /* ------------------------ destinations + pools ------------------------ */

        _configureTokens(manager, settler, oracle, fxrp, deployer);

        /* ------------------------------ minter -------------------------------- */

        fxrp.mint(deployer, MINTER_RESERVE);
        fxrp.approve(address(minter), MINTER_RESERVE);
        minter.fundReserve(MINTER_RESERVE);

        vm.stopBroadcast();

        _write(address(manager), address(settler), address(oracle), address(minter), address(fxrp), deployer);

        console2.log("");
        console2.log("======== FlareSwap local devnet ========");
        console2.log("IntentManager  ", address(manager));
        console2.log("IntentSettler  ", address(settler));
        console2.log("PriceOracle    ", address(oracle));
        console2.log("Minter         ", address(minter));
        console2.log("FXRP           ", address(fxrp));
        console2.log("MockFtsoV2     ", address(ftso));
        console2.log("MockFdc        ", address(fdc));
        console2.log("Registry(mock) ", address(registry));
        for (uint256 i = 0; i < tokenAddresses.length; i++) {
            console2.log(
                string.concat("  ", tokenSymbols[i], " / pool"), tokenAddresses[i], tokenPools[i]
            );
        }
        console2.log("========================================");
    }

    /* ------------------------------------------------------------------ */
    /*                        destinations + pools                         */
    /* ------------------------------------------------------------------ */

    /// @dev Deploys each destination token, gives it an FXRP pool seeded at the live oracle
    ///      rate, and registers it on both the manager and the settler. Seeding on-market
    ///      matters: the settler rejects any fill below the FTSO-derived floor, so a pool opened
    ///      at an arbitrary ratio would reject every settlement until arbitrage repaired it.
    function _configureTokens(
        IntentManager manager,
        IntentSettler settler,
        PriceOracle oracle,
        MockERC20 fxrp,
        address deployer
    ) internal {
        TokenSet.Spec[] memory specs = TokenSet.all();

        for (uint256 i = 0; i < specs.length; i++) {
            TokenSet.Spec memory spec = specs[i];

            address token;
            address pool;

            if (spec.isFAsset) {
                token = address(fxrp);
            } else {
                MockERC20 erc20 = new MockERC20(spec.name, spec.symbol, spec.decimals);
                token = address(erc20);

                // Price the destination side off FTSO so the pool opens at the oracle rate.
                uint256 quoteAmount = oracle.getQuote(
                    FeedIds.XRP_USD, spec.feedId, spec.seedFxrp, 6, spec.decimals
                );

                LiquidityPool liquidityPool = new LiquidityPool(
                    address(fxrp),
                    token,
                    deployer,
                    string.concat("FlareSwap FXRP/", spec.symbol, " LP"),
                    string.concat("FS-", spec.symbol)
                );
                pool = address(liquidityPool);

                fxrp.mint(deployer, spec.seedFxrp);
                erc20.mint(deployer, quoteAmount);
                fxrp.approve(pool, spec.seedFxrp);
                erc20.approve(pool, quoteAmount);
                liquidityPool.addLiquidity(
                    spec.seedFxrp, quoteAmount, 0, 0, deployer, block.timestamp + 1 hours
                );

                settler.setPool(token, pool);
            }

            manager.configureToken(
                token,
                TokenConfig({
                    enabled: true,
                    decimals: spec.decimals,
                    feedId: spec.feedId,
                    symbol: spec.symbol
                })
            );

            tokenAddresses.push(token);
            tokenSymbols.push(spec.symbol);
            tokenDecimals.push(spec.decimals);
            tokenPools.push(pool);
        }
    }

    /* ------------------------------------------------------------------ */
    /*                               output                                */
    /* ------------------------------------------------------------------ */

    function _write(
        address manager,
        address settler,
        address oracle,
        address minter,
        address fxrp,
        address relayer
    ) internal {
        string memory key = "flareswap-local";
        vm.serializeUint(key, "chainId", block.chainid);
        vm.serializeUint(key, "blockNumber", block.number);
        vm.serializeAddress(key, "intentManager", manager);
        vm.serializeAddress(key, "intentSettler", settler);
        vm.serializeAddress(key, "priceOracle", oracle);
        vm.serializeAddress(key, "minter", minter);
        vm.serializeAddress(key, "fxrp", fxrp);
        vm.serializeAddress(key, "relayer", relayer);
        vm.serializeBool(key, "usesFAssets", false);
        vm.serializeString(key, "xrplSourceId", "testXRP");

        // Parallel arrays rather than an array of objects: forge's JSON cheatcodes cannot nest
        // objects inside arrays cleanly, and the consumers zip these back together in one line.
        vm.serializeAddress(key, "tokenAddresses", tokenAddresses);
        vm.serializeString(key, "tokenSymbols", tokenSymbols);
        vm.serializeUint(key, "tokenDecimals", tokenDecimals);
        vm.serializeAddress(key, "tokenPools", tokenPools);

        // Kept so anything still reading a single pool keeps working.
        vm.serializeAddress(key, "liquidityPool", tokenPools[0]);
        vm.serializeAddress(key, "usdc", tokenAddresses[0]);

        string memory json = vm.serializeString(key, "xrplDepositAddress", XRPL_DEPOSIT_ADDRESS);
        vm.writeJson(json, string.concat("deployments/", vm.toString(block.chainid), ".json"));
    }
}
