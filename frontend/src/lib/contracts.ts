import {Contract, JsonRpcProvider, type InterfaceAbi, type Signer} from "ethers";
import {IntentManagerAbi, IntentSettlerAbi, LiquidityPoolAbi, MockERC20Abi, PriceOracleAbi} from "@/abis";
import {DEFAULT_CHAIN_ID, chainInfo} from "./constants";
import type {AppConfig} from "./types";

/**
 * Read-only provider used for everything the user is not signing.
 *
 * Deliberately separate from the wallet's provider: reads keep working when no wallet is
 * installed, which is what makes the landing page, explorer and docs render for a judge who
 * has not connected anything.
 */
/**
 * Cached per URL, not globally.
 *
 * A single slot meant the first caller won: if anything read before `/api/config` resolved, the
 * provider latched onto the compile-time default RPC and every later call — including ones that
 * passed the correct URL — silently went to the wrong node.
 */
const readProviders = new Map<string, JsonRpcProvider>();

export function getReadProvider(rpcUrl?: string): JsonRpcProvider {
  const url = rpcUrl ?? chainInfo(DEFAULT_CHAIN_ID).rpcUrls[0];
  let provider = readProviders.get(url);
  if (!provider) {
    provider = new JsonRpcProvider(url, DEFAULT_CHAIN_ID, {staticNetwork: true});
    readProviders.set(url, provider);
  }
  return provider;
}

function read(address: string, abi: InterfaceAbi, rpcUrl?: string): Contract {
  return new Contract(address, abi, getReadProvider(rpcUrl));
}

export function intentManagerRead(config: AppConfig): Contract {
  return read(config.contracts.intentManager, IntentManagerAbi as InterfaceAbi, config.rpcUrl);
}

export function intentSettlerRead(config: AppConfig): Contract {
  return read(config.contracts.intentSettler, IntentSettlerAbi as InterfaceAbi, config.rpcUrl);
}

export function priceOracleRead(config: AppConfig): Contract {
  return read(config.contracts.priceOracle, PriceOracleAbi as InterfaceAbi, config.rpcUrl);
}

export function liquidityPoolRead(config: AppConfig, poolAddress: string): Contract {
  return read(poolAddress, LiquidityPoolAbi as InterfaceAbi, config.rpcUrl);
}

export function erc20Read(address: string, config?: AppConfig): Contract {
  return read(address, MockERC20Abi as InterfaceAbi, config?.rpcUrl);
}

/* ------------------------------- write side ------------------------------- */

export function intentManagerWrite(config: AppConfig, signer: Signer): Contract {
  return new Contract(config.contracts.intentManager, IntentManagerAbi as InterfaceAbi, signer);
}

export function liquidityPoolWrite(poolAddress: string, signer: Signer): Contract {
  return new Contract(poolAddress, LiquidityPoolAbi as InterfaceAbi, signer);
}

export function erc20Write(address: string, signer: Signer): Contract {
  return new Contract(address, MockERC20Abi as InterfaceAbi, signer);
}

/* --------------------------------- errors --------------------------------- */

const FRIENDLY_ERRORS: Record<string, string> = {
  SourceChainDisabled: "That source chain is not enabled yet.",
  TokenDisabled: "That destination token is not supported.",
  AmountOutOfRange: "Amount is outside the allowed range for this chain.",
  SlippageTooHigh: "Slippage tolerance is above the protocol maximum of 50%.",
  DeadlineInPast: "Deadline must be at least 5 minutes from now.",
  DeadlineTooFar: "Deadline cannot be more than 7 days out.",
  NotIntentOwner: "Only the wallet that created this intent can cancel it.",
  InvalidStatus: "This intent is no longer in a state that allows that action.",
  InsufficientOutputAmount: "The pool cannot fill this at your minimum output.",
  InsufficientLiquidity: "Not enough liquidity in the pool for this trade.",
  PriceStale: "The FTSO price feed is stale — try again in a moment.",
  InvalidProof: "The FDC proof did not verify on-chain.",
  ProofAlreadyUsed: "That XRPL payment has already settled another intent.",
  DepositTooSmall: "The deposit is smaller than the intent's declared amount.",
  Expired: "Transaction deadline passed before it was mined.",
};

/**
 * Turns an ethers rejection into something a user can act on.
 *
 * Custom errors are the norm across these contracts, so the raw message is usually an opaque
 * selector; ethers decodes the name when it has the ABI, which is what this keys off.
 */
export function describeContractError(error: unknown): string {
  if (!error) return "Unknown error";

  const candidate = error as {
    code?: string | number;
    reason?: string;
    shortMessage?: string;
    message?: string;
    revert?: {name?: string; args?: unknown[]};
    info?: {error?: {message?: string}};
  };

  if (candidate.code === "ACTION_REJECTED" || candidate.code === 4001) {
    return "Transaction rejected in your wallet.";
  }

  const revertName = candidate.revert?.name;
  if (revertName && FRIENDLY_ERRORS[revertName]) return FRIENDLY_ERRORS[revertName]!;
  if (revertName) return `Reverted: ${revertName}`;

  for (const [name, friendly] of Object.entries(FRIENDLY_ERRORS)) {
    if (candidate.message?.includes(name)) return friendly;
  }

  if (candidate.code === "INSUFFICIENT_FUNDS") {
    return "Not enough native gas token in your wallet.";
  }

  return (
    candidate.shortMessage ??
    candidate.reason ??
    candidate.info?.error?.message ??
    candidate.message ??
    "Transaction failed"
  );
}
