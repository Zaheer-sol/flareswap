import {Contract, JsonRpcProvider, Wallet, type InterfaceAbi} from "ethers";
import {config, requireDeployment} from "../config.js";
import {IntentManagerAbi, IntentSettlerAbi, PriceOracleAbi, LiquidityPoolAbi, MockERC20Abi} from "../abis/index.js";

/** Canonical FlareContractRegistry — same address on Flare, Songbird, Coston and Coston2. */
export const FLARE_CONTRACT_REGISTRY = "0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019";

const REGISTRY_ABI = [
  "function getContractAddressByName(string _name) view returns (address)",
] as const;

/** The slice of FdcHub / Relay / fee-config we need to drive an attestation round. */
const FDC_HUB_ABI = [
  "function requestAttestation(bytes _data) payable",
  "event AttestationRequest(bytes data, uint256 fee)",
] as const;

const FDC_FEE_CONFIG_ABI = [
  "function getRequestFee(bytes _data) view returns (uint256)",
] as const;

const RELAY_ABI = [
  "function getVotingRoundId(uint256 _timestamp) view returns (uint256)",
  "function isFinalized(uint256 _protocolId, uint256 _votingRoundId) view returns (bool)",
  "function merkleRoots(uint256 _protocolId, uint256 _votingRoundId) view returns (bytes32)",
] as const;

export const provider = new JsonRpcProvider(config.flareRpcUrl, config.chainId, {
  staticNetwork: true,
  batchMaxCount: 10,
});

let cachedWallet: Wallet | null = null;

/** The operator key. Absent in read-only deployments (price API without a relayer). */
export function getWallet(): Wallet | null {
  if (!config.relayerPrivateKey) return null;
  if (!cachedWallet) cachedWallet = new Wallet(config.relayerPrivateKey, provider);
  return cachedWallet;
}

export function requireWallet(): Wallet {
  const wallet = getWallet();
  if (!wallet) throw new Error("RELAYER_PRIVATE_KEY is not set — cannot send transactions.");
  return wallet;
}

function contractAt(address: string, abi: InterfaceAbi, writable = false): Contract {
  const runner = writable ? requireWallet() : provider;
  return new Contract(address, abi, runner);
}

/* -------------------------------------------------------------------------- */
/*                            FlareSwap contracts                             */
/* -------------------------------------------------------------------------- */

export function intentManager(writable = false): Contract {
  return contractAt(requireDeployment().intentManager, IntentManagerAbi as InterfaceAbi, writable);
}

export function intentSettler(writable = false): Contract {
  return contractAt(requireDeployment().intentSettler, IntentSettlerAbi as InterfaceAbi, writable);
}

export function priceOracle(): Contract {
  return contractAt(requireDeployment().priceOracle, PriceOracleAbi as InterfaceAbi);
}

/** @param address specific pool; defaults to the first configured destination's pool. */
export function liquidityPool(address?: string, writable = false): Contract {
  const deployment = requireDeployment();
  const pool = address ?? deployment.tokens.find((token) => token.hasPool)?.pool;
  if (!pool) throw new Error("no liquidity pool is configured for this deployment");
  return contractAt(pool, LiquidityPoolAbi as InterfaceAbi, writable);
}

export function erc20(address: string, writable = false): Contract {
  return contractAt(address, MockERC20Abi as InterfaceAbi, writable);
}

/* -------------------------------------------------------------------------- */
/*                              Flare protocols                               */
/* -------------------------------------------------------------------------- */

const registryContract = new Contract(FLARE_CONTRACT_REGISTRY, REGISTRY_ABI, provider);
const addressCache = new Map<string, string>();

/** Resolves a Flare system contract by registered name, memoised for the process lifetime. */
export async function resolveFlareContract(name: string): Promise<string> {
  const cached = addressCache.get(name);
  if (cached) return cached;

  const address: string = await registryContract.getContractAddressByName(name);
  if (!address || address === "0x0000000000000000000000000000000000000000") {
    throw new Error(`FlareContractRegistry has no entry for "${name}" on chain ${config.chainId}`);
  }
  addressCache.set(name, address);
  return address;
}

export async function fdcHub(writable = true): Promise<Contract> {
  return contractAt(await resolveFlareContract("FdcHub"), FDC_HUB_ABI as unknown as InterfaceAbi, writable);
}

export async function fdcRequestFeeConfigurations(): Promise<Contract> {
  return contractAt(
    await resolveFlareContract("FdcRequestFeeConfigurations"),
    FDC_FEE_CONFIG_ABI as unknown as InterfaceAbi,
  );
}

export async function relay(): Promise<Contract> {
  return contractAt(await resolveFlareContract("Relay"), RELAY_ABI as unknown as InterfaceAbi);
}

/* -------------------------------------------------------------------------- */
/*                                  helpers                                   */
/* -------------------------------------------------------------------------- */

const EXPLORERS: Record<number, string> = {
  14: "https://flare-explorer.flare.network",
  114: "https://coston2-explorer.flare.network",
  19: "https://songbird-explorer.flare.network",
  16: "https://coston-explorer.flare.network",
};

export function explorerTxUrl(txHash: string): string {
  const base = EXPLORERS[config.chainId];
  return base ? `${base}/tx/${txHash}` : txHash;
}

export function explorerAddressUrl(address: string): string {
  const base = EXPLORERS[config.chainId];
  return base ? `${base}/address/${address}` : address;
}

export function xrplExplorerTxUrl(txHash: string): string {
  const isTestnet = config.xrpl.sourceId.toLowerCase().startsWith("test");
  return isTestnet
    ? `https://testnet.xrpl.org/transactions/${txHash}`
    : `https://livenet.xrpl.org/transactions/${txHash}`;
}
