/** Chain metadata and app-wide constants. */

export const COSTON2 = {
  chainId: 114,
  chainIdHex: "0x72",
  name: "Flare Testnet Coston2",
  currency: {name: "Coston2 Flare", symbol: "C2FLR", decimals: 18},
  rpcUrls: ["https://coston2-api.flare.network/ext/C/rpc"],
  explorer: "https://coston2-explorer.flare.network",
  faucet: "https://faucet.flare.network/coston2",
} as const;

export const FLARE_MAINNET = {
  chainId: 14,
  chainIdHex: "0xe",
  name: "Flare Mainnet",
  currency: {name: "Flare", symbol: "FLR", decimals: 18},
  rpcUrls: ["https://flare-api.flare.network/ext/C/rpc"],
  explorer: "https://flare-explorer.flare.network",
  faucet: null,
} as const;

/**
 * Anvil, for `script/DeployLocal.s.sol`. Listed so wallet add/switch works against it too.
 *
 * The gas token is labelled C2FLR rather than Foundry's default ETH. Anvil is a generic EVM node
 * whose native token has no real identity, and `nativeCurrency` is display-only — but this devnet
 * exists to stand in for Coston2, and showing "ETH" in the wallet invites the reasonable worry
 * that real ether is at stake. Naming it after what it simulates is both accurate and calmer.
 */
export const LOCAL_DEVNET = {
  chainId: 31337,
  chainIdHex: "0x7a69",
  name: "FlareSwap Local Devnet",
  currency: {name: "Coston2 Flare (local)", symbol: "C2FLR", decimals: 18},
  rpcUrls: ["http://127.0.0.1:8545"],
  explorer: "",
  faucet: null,
} as const;

export type ChainInfo = typeof COSTON2 | typeof FLARE_MAINNET | typeof LOCAL_DEVNET;

export const SUPPORTED_CHAINS: ChainInfo[] = [COSTON2, FLARE_MAINNET, LOCAL_DEVNET];

export const DEFAULT_CHAIN_ID = Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? COSTON2.chainId);

/**
 * Metadata for a chain id.
 *
 * Throws rather than falling back: an unknown id previously resolved to Coston2, which meant the
 * "switch network" button silently pointed the wallet at a chain with no deployment on it — a
 * failure that looks like "the wallet is broken" rather than "this chain is unsupported".
 */
export function chainInfo(chainId: number): ChainInfo {
  const found = SUPPORTED_CHAINS.find((chain) => chain.chainId === chainId);
  if (!found) {
    throw new Error(
      `Chain ${chainId} is not configured. Add it to SUPPORTED_CHAINS in src/lib/constants.ts.`,
    );
  }
  return found;
}

export function isSupportedChain(chainId: number): boolean {
  return SUPPORTED_CHAINS.some((chain) => chain.chainId === chainId);
}

/** Explorer link helper — local devnet has no explorer, so callers get null. */
export function explorerTxUrl(chainId: number, txHash: string): string | null {
  const base = isSupportedChain(chainId) ? chainInfo(chainId).explorer : "";
  return base ? `${base}/tx/${txHash}` : null;
}

export function explorerAddressUrl(chainId: number, address: string): string | null {
  const base = isSupportedChain(chainId) ? chainInfo(chainId).explorer : "";
  return base ? `${base}/address/${address}` : null;
}

export const API_BASE = (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000").replace(/\/$/, "");
export const WS_URL = API_BASE.replace(/^http/, "ws") + "/ws";

/** Source chains the contracts understand. BTC is configured but not enabled yet. */
export const SOURCE_CHAINS = [
  {id: 0, name: "XRPL", symbol: "XRP", decimals: 6, enabled: true},
  {id: 1, name: "Bitcoin", symbol: "BTC", decimals: 8, enabled: false},
] as const;

export const SLIPPAGE_PRESETS = [50, 100, 300] as const;
export const DEFAULT_SLIPPAGE_BPS = 100;

/** Must sit inside IntentManager's MIN/MAX_DEADLINE_WINDOW (5 minutes to 7 days). */
export const DEADLINE_OPTIONS = [
  {label: "30 minutes", seconds: 30 * 60},
  {label: "1 hour", seconds: 60 * 60},
  {label: "6 hours", seconds: 6 * 60 * 60},
  {label: "24 hours", seconds: 24 * 60 * 60},
] as const;

export const DEFAULT_DEADLINE_SECONDS = 60 * 60;

export const LINKS = {
  github: "https://github.com/your-org/flareswap",
  hackathon: "https://dorahacks.io/hackathon/flaresummersignal",
  flareDevHub: "https://dev.flare.network",
  fdcDocs: "https://dev.flare.network/fdc/overview",
  ftsoDocs: "https://dev.flare.network/ftso/overview",
  fassetsDocs: "https://dev.flare.network/fxrp/overview",
} as const;

/** Mirrors the six-step stepper on the intent status page. */
export const PROGRESS_STEPS = [
  {key: "created", label: "Intent Created", detail: "Terms committed on Flare"},
  {key: "deposited", label: "XRP Deposited", detail: "Payment seen on XRPL"},
  {key: "verified", label: "FDC Verified", detail: "Attested by Flare validators"},
  {key: "minted", label: "FXRP Minted", detail: "FAssets issued on Flare"},
  {key: "swapped", label: "Swapped", detail: "Executed against the pool"},
  {key: "delivered", label: "Delivered", detail: "Output sent to your wallet"},
] as const;
