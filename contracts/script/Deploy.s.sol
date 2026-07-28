// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {IntentManager} from "../src/IntentManager.sol";
import {IntentSettler} from "../src/IntentSettler.sol";
import {PriceOracle} from "../src/PriceOracle.sol";
import {LiquidityPool} from "../src/LiquidityPool.sol";
import {PooledFxrpMinter} from "../src/adapters/PooledFxrpMinter.sol";
import {FAssetsMinter} from "../src/adapters/FAssetsMinter.sol";
import {FeedIds} from "../src/libraries/FeedIds.sol";
import {SourceChainConfig, TokenConfig} from "../src/interfaces/IIntentManager.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";

import {TokenSet} from "./TokenSet.sol";

/// @notice Deploys and wires the full FlareSwap stack, then writes the addresses to
///         `deployments/<chainId>.json` for the backend and frontend to consume.
///
/// @dev Environment:
///        PRIVATE_KEY            deployer key (required)
///        XRPL_DEPOSIT_ADDRESS   XRPL address users pay into (required)
///        XRPL_SOURCE_ID         FDC source id; "testXRP" on testnet, "XRP" on mainnet
///        FXRP_ADDRESS           existing FXRP; if unset a MockERC20 is deployed
///        ASSET_MANAGER_ADDRESS  FAssets AssetManager; if set, FAssetsMinter is used instead
///                               of PooledFxrpMinter
///        RELAYER_ADDRESS        relayer operator key (defaults to the deployer)
///        FEE_RECIPIENT          protocol fee sink (defaults to the deployer)
///        SEED_POOLS             "true" to seed each pool during deploy (default false — run
///                               script/Seed.s.sol separately so a failed seed cannot strand
///                               a partially configured deployment)
///
/// @dev Usage:
///        forge script script/Deploy.s.sol:Deploy --rpc-url coston2 --broadcast --slow -vvv
contract Deploy is Script {
    uint8 internal constant CHAIN_XRPL = 0;
    uint8 internal constant XRP_DECIMALS = 6;

    address[] internal tokenAddresses;
    string[] internal tokenSymbols;
    uint256[] internal tokenDecimals;
    address[] internal tokenPools;

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);

        string memory xrplDepositAddress = vm.envString("XRPL_DEPOSIT_ADDRESS");
        string memory xrplSourceId = vm.envOr("XRPL_SOURCE_ID", string("testXRP"));
        address assetManager = vm.envOr("ASSET_MANAGER_ADDRESS", address(0));
        address relayerAddress = vm.envOr("RELAYER_ADDRESS", deployer);
        address feeRecipient = vm.envOr("FEE_RECIPIENT", deployer);
        bool seedPools = vm.envOr("SEED_POOLS", false);

        console2.log("deployer      ", deployer);
        console2.log("chain id      ", block.chainid);
        console2.log("xrpl deposit  ", xrplDepositAddress);
        console2.log("xrpl source id", xrplSourceId);

        vm.startBroadcast(deployerKey);

        /* ------------------------------- FXRP -------------------------------- */

        address fxrp = vm.envOr("FXRP_ADDRESS", address(0));
        if (fxrp == address(0)) {
            fxrp = address(new MockERC20("FAsset XRP (test)", "FXRP", 6));
            console2.log("deployed test FXRP", fxrp);
        }

        /* ------------------------------- core -------------------------------- */

        // `address(0)` makes PriceOracle/IntentSettler fall back to the canonical registry at
        // 0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019, which is correct on every Flare network.
        address registry = vm.envOr("FLARE_REGISTRY_ADDRESS", address(0));

        IntentManager manager = new IntentManager(deployer);
        PriceOracle oracle = new PriceOracle(registry, deployer);
        IntentSettler settler = new IntentSettler(address(manager), address(oracle), registry, deployer);

        /* ------------------------------ minter ------------------------------- */

        address minter;
        bool usesFAssets = assetManager != address(0);
        if (usesFAssets) {
            FAssetsMinter fassetsMinter = new FAssetsMinter(assetManager, XRP_DECIMALS, deployer);
            fassetsMinter.setAuthorized(address(settler), true);
            fassetsMinter.setAuthorized(relayerAddress, true);
            minter = address(fassetsMinter);
            console2.log("using FAssetsMinter against AssetManager", assetManager);
        } else {
            PooledFxrpMinter pooledMinter = new PooledFxrpMinter(fxrp, XRP_DECIMALS, deployer);
            pooledMinter.setAuthorized(address(settler), true);
            minter = address(pooledMinter);
            console2.log("using PooledFxrpMinter (pre-minted FXRP reserve)");
        }

        /* --------------------------- configuration --------------------------- */

        manager.setAuthorized(address(settler), true);
        manager.setAuthorized(relayerAddress, true);

        manager.configureSourceChain(
            CHAIN_XRPL,
            SourceChainConfig({
                enabled: true,
                decimals: XRP_DECIMALS,
                feedId: FeedIds.XRP_USD,
                sourceId: _toBytes32(xrplSourceId),
                // The FDC hashes the standardised address string: keccak256(bytes(address)).
                depositAddressHash: keccak256(bytes(xrplDepositAddress)),
                name: "XRPL",
                symbol: "XRP",
                depositAddress: xrplDepositAddress
            }),
            vm.envOr("MIN_DEPOSIT_DROPS", uint256(1e6)), // 1 XRP
            vm.envOr("MAX_DEPOSIT_DROPS", uint256(1_000_000e6)) // 1M XRP
        );

        settler.setMinter(minter);
        settler.setProtocolFee(30, feeRecipient);
        settler.setRelayer(relayerAddress, true);

        _configureTokens(manager, settler, oracle, fxrp, deployer, seedPools);

        vm.stopBroadcast();

        _log(address(manager), address(settler), address(oracle), minter, fxrp);
        _write(
            address(manager),
            address(settler),
            address(oracle),
            minter,
            fxrp,
            relayerAddress,
            usesFAssets,
            xrplDepositAddress,
            xrplSourceId
        );
    }

    /* ------------------------------------------------------------------ */
    /*                        destinations + pools                         */
    /* ------------------------------------------------------------------ */

    /// @dev One pool per destination, each registered on the settler. An existing token can be
    ///      supplied per symbol via `<SYMBOL>_ADDRESS` (e.g. `USDC_ADDRESS`); anything not
    ///      supplied is deployed as a MockERC20 so a testnet without the real asset still works.
    function _configureTokens(
        IntentManager manager,
        IntentSettler settler,
        PriceOracle oracle,
        address fxrp,
        address deployer,
        bool seedPools
    ) internal {
        TokenSet.Spec[] memory specs = TokenSet.all();

        for (uint256 i = 0; i < specs.length; i++) {
            TokenSet.Spec memory spec = specs[i];

            address token;
            address pool;

            if (spec.isFAsset) {
                token = fxrp;
            } else {
                token = vm.envOr(string.concat(spec.symbol, "_ADDRESS"), address(0));
                if (token == address(0)) {
                    token = address(new MockERC20(spec.name, spec.symbol, spec.decimals));
                    console2.log(string.concat("deployed test ", spec.symbol), token);
                }

                LiquidityPool liquidityPool = new LiquidityPool(
                    fxrp,
                    token,
                    deployer,
                    string.concat("FlareSwap FXRP/", spec.symbol, " LP"),
                    string.concat("FS-", spec.symbol)
                );
                pool = address(liquidityPool);
                settler.setPool(token, pool);

                if (seedPools) {
                    _seed(oracle, liquidityPool, fxrp, token, spec, deployer);
                }
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

    /// @dev Seeds at the live FTSO rate. Only reachable when the deployer actually holds both
    ///      sides, or when the token is a MockERC20 we just deployed and can mint.
    function _seed(
        PriceOracle oracle,
        LiquidityPool pool,
        address fxrp,
        address token,
        TokenSet.Spec memory spec,
        address deployer
    ) internal {
        uint256 quoteAmount =
            oracle.getQuote(FeedIds.XRP_USD, spec.feedId, spec.seedFxrp, 6, spec.decimals);

        _mintIfPossible(fxrp, deployer, spec.seedFxrp);
        _mintIfPossible(token, deployer, quoteAmount);

        IERC20(fxrp).approve(address(pool), spec.seedFxrp);
        IERC20(token).approve(address(pool), quoteAmount);
        pool.addLiquidity(spec.seedFxrp, quoteAmount, 0, 0, deployer, block.timestamp + 1 hours);
    }

    function _mintIfPossible(address token, address to, uint256 amount) internal {
        if (IERC20(token).balanceOf(to) >= amount) return;
        uint256 shortfall = amount - IERC20(token).balanceOf(to);
        (bool ok,) = token.call(abi.encodeWithSelector(MockERC20.mint.selector, to, shortfall));
        require(ok, "Deploy: token is not mintable and balance is short");
    }

    /* ------------------------------------------------------------------ */
    /*                              reporting                              */
    /* ------------------------------------------------------------------ */

    function _log(address manager, address settler, address oracle, address minter, address fxrp)
        internal
        view
    {
        console2.log("");
        console2.log("=========== FlareSwap deployed ===========");
        console2.log("IntentManager ", manager);
        console2.log("IntentSettler ", settler);
        console2.log("PriceOracle   ", oracle);
        console2.log("Minter        ", minter);
        console2.log("FXRP          ", fxrp);
        for (uint256 i = 0; i < tokenAddresses.length; i++) {
            console2.log(string.concat("  ", tokenSymbols[i]), tokenAddresses[i], tokenPools[i]);
        }
        console2.log("=========================================");
    }

    function _write(
        address manager,
        address settler,
        address oracle,
        address minter,
        address fxrp,
        address relayerAddress,
        bool usesFAssets,
        string memory xrplDepositAddress,
        string memory xrplSourceId
    ) internal {
        string memory key = "flareswap";
        vm.serializeUint(key, "chainId", block.chainid);
        vm.serializeUint(key, "blockNumber", block.number);
        vm.serializeAddress(key, "intentManager", manager);
        vm.serializeAddress(key, "intentSettler", settler);
        vm.serializeAddress(key, "priceOracle", oracle);
        vm.serializeAddress(key, "minter", minter);
        vm.serializeAddress(key, "fxrp", fxrp);
        vm.serializeAddress(key, "relayer", relayerAddress);
        vm.serializeBool(key, "usesFAssets", usesFAssets);
        vm.serializeString(key, "xrplSourceId", xrplSourceId);

        // Parallel arrays rather than an array of objects: forge's JSON cheatcodes cannot nest
        // objects inside arrays cleanly, and the consumers zip these back together in one line.
        vm.serializeAddress(key, "tokenAddresses", tokenAddresses);
        vm.serializeString(key, "tokenSymbols", tokenSymbols);
        vm.serializeUint(key, "tokenDecimals", tokenDecimals);
        vm.serializeAddress(key, "tokenPools", tokenPools);

        // Kept so anything still reading a single pool keeps working.
        vm.serializeAddress(key, "liquidityPool", tokenPools[0]);
        vm.serializeAddress(key, "usdc", tokenAddresses[0]);

        string memory json = vm.serializeString(key, "xrplDepositAddress", xrplDepositAddress);
        string memory path = string.concat("deployments/", vm.toString(block.chainid), ".json");
        vm.writeJson(json, path);
        console2.log("wrote", path);
    }

    /// @dev FDC source ids are the ASCII name right-padded to 32 bytes, e.g. "testXRP".
    function _toBytes32(string memory s) internal pure returns (bytes32 result) {
        bytes memory b = bytes(s);
        require(b.length > 0 && b.length <= 32, "source id must be 1-32 bytes");
        assembly {
            result := mload(add(b, 32))
        }
    }
}
