import {readFileSync, existsSync} from "node:fs";
import {dirname, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import dotenv from "dotenv";
import {z} from "zod";

dotenv.config();

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");

/** Addresses written by `forge script script/Deploy.s.sol`. */
const deploymentSchema = z.object({
  chainId: z.number(),
  blockNumber: z.number().optional(),
  intentManager: z.string(),
  intentSettler: z.string(),
  priceOracle: z.string(),
  minter: z.string(),
  fxrp: z.string(),
  relayer: z.string().optional(),
  usesFAssets: z.boolean().optional(),
  xrplDepositAddress: z.string().optional(),
  xrplSourceId: z.string().optional(),

  // Destination tokens, written as parallel arrays because forge's JSON cheatcodes cannot
  // nest objects inside an array. Zipped into `tokens` below.
  tokenAddresses: z.array(z.string()),
  tokenSymbols: z.array(z.string()),
  tokenDecimals: z.array(z.number()),
  tokenPools: z.array(z.string()),

  // Retained for compatibility with anything still expecting a single pair.
  liquidityPool: z.string().optional(),
  usdc: z.string().optional(),
});

type RawDeployment = z.infer<typeof deploymentSchema>;

export interface DestinationToken {
  address: string;
  symbol: string;
  decimals: number;
  /** Zero address for the FAsset itself, which is delivered without an AMM hop. */
  pool: string;
  hasPool: boolean;
}

export type Deployment = RawDeployment & {tokens: DestinationToken[]};

const ZERO = "0x0000000000000000000000000000000000000000";

/** Zips the parallel arrays into something the rest of the codebase can iterate. */
function withTokens(raw: RawDeployment): Deployment {
  const tokens: DestinationToken[] = raw.tokenAddresses.map((address, index) => {
    const pool = raw.tokenPools[index] ?? ZERO;
    return {
      address,
      symbol: raw.tokenSymbols[index] ?? "???",
      decimals: raw.tokenDecimals[index] ?? 18,
      pool,
      hasPool: pool !== ZERO,
    };
  });
  return {...raw, tokens};
}

const envSchema = z.object({
  CHAIN_ID: z.coerce.number().default(114),
  FLARE_RPC_URL: z.string().default("https://coston2-api.flare.network/ext/C/rpc"),
  RELAYER_PRIVATE_KEY: z.string().optional(),

  XRPL_WS_URL: z.string().default("wss://s.altnet.rippletest.net:51233"),
  XRPL_DEPOSIT_ADDRESS: z.string().optional(),
  XRPL_SOURCE_ID: z.string().default("testXRP"),
  XRPL_CONFIRMATIONS: z.coerce.number().default(1),

  FDC_VERIFIER_URL: z.string().default("https://fdc-verifiers-testnet.flare.network"),
  FDC_VERIFIER_API_KEY: z.string().default(""),
  FDC_DA_LAYER_URL: z.string().default("https://ctn2-data-availability.flare.network"),
  FDC_DA_LAYER_API_KEY: z.string().default(""),
  FDC_PROTOCOL_ID: z.coerce.number().default(200),

  PORT: z.coerce.number().default(4000),
  CORS_ORIGIN: z.string().default("http://localhost:3000"),
  DATABASE_PATH: z.string().default("./data/flareswap.db"),

  PRICE_POLL_INTERVAL_MS: z.coerce.number().default(2000),
  RELAYER_TICK_INTERVAL_MS: z.coerce.number().default(5000),
  INDEXER_POLL_INTERVAL_MS: z.coerce.number().default(5000),
  INDEXER_START_BLOCK: z.coerce.number().default(0),
  LOG_LEVEL: z.string().default("info"),
});

const env = envSchema.parse(process.env);

function loadDeployment(chainId: number): Deployment | null {
  const path = resolve(repoRoot, "contracts/deployments", `${chainId}.json`);
  if (!existsSync(path)) return null;
  return withTokens(deploymentSchema.parse(JSON.parse(readFileSync(path, "utf8"))));
}

const deployment = loadDeployment(env.CHAIN_ID);

/**
 * The deposit address is load-bearing: `IntentSettler` compares
 * `keccak256(bytes(depositAddress))` from its own config against the FDC proof's
 * `receivingAddressHash`. If the relayer watches a different address than the one the contract
 * was configured with, every settlement fails the `WrongReceivingAddress` check. Preferring the
 * deployment file over the env var keeps the two in lockstep by construction.
 */
const xrplDepositAddress = deployment?.xrplDepositAddress ?? env.XRPL_DEPOSIT_ADDRESS ?? "";
const xrplSourceId = deployment?.xrplSourceId ?? env.XRPL_SOURCE_ID;

export const config = {
  chainId: env.CHAIN_ID,
  flareRpcUrl: env.FLARE_RPC_URL,
  relayerPrivateKey: env.RELAYER_PRIVATE_KEY,

  xrpl: {
    wsUrl: env.XRPL_WS_URL,
    depositAddress: xrplDepositAddress,
    sourceId: xrplSourceId,
    confirmations: env.XRPL_CONFIRMATIONS,
  },

  fdc: {
    verifierUrl: env.FDC_VERIFIER_URL.replace(/\/$/, ""),
    verifierApiKey: env.FDC_VERIFIER_API_KEY,
    daLayerUrl: env.FDC_DA_LAYER_URL.replace(/\/$/, ""),
    daLayerApiKey: env.FDC_DA_LAYER_API_KEY,
    protocolId: env.FDC_PROTOCOL_ID,
  },

  api: {
    port: env.PORT,
    corsOrigin: env.CORS_ORIGIN,
  },

  databasePath: resolve(repoRoot, "backend", env.DATABASE_PATH),

  intervals: {
    price: env.PRICE_POLL_INTERVAL_MS,
    relayer: env.RELAYER_TICK_INTERVAL_MS,
    indexer: env.INDEXER_POLL_INTERVAL_MS,
  },

  indexerStartBlock: env.INDEXER_START_BLOCK || deployment?.blockNumber || 0,
  deployment,
  repoRoot,
} as const;

/** True when there is enough configuration to actually relay, not just serve reads. */
export function canRelay(): boolean {
  return Boolean(config.relayerPrivateKey && config.deployment && config.xrpl.depositAddress);
}

export function requireDeployment(): Deployment {
  if (!config.deployment) {
    throw new Error(
      `No deployment found for chain ${config.chainId}. ` +
        `Run 'forge script script/Deploy.s.sol:Deploy --rpc-url <net> --broadcast' first.`,
    );
  }
  return config.deployment;
}
