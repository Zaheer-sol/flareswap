/** Response shapes served by the backend. Kept in step with `backend/src/types.ts`. */

export type IntentStatus =
  | "PENDING"
  | "DEPOSITED"
  | "ATTESTATION_REQUESTED"
  | "ATTESTATION_READY"
  | "SETTLING"
  | "SETTLED"
  | "EXPIRED"
  | "CANCELLED"
  | "FAILED";

export interface IntentRecord {
  intentId: string;
  userAddress: string;
  status: IntentStatus;
  sourceChain: number;
  sourceToken: string;
  sourceAmount: string;
  destinationToken: string;
  destinationSymbol: string;
  minOutputAmount: string;
  outputAmount: string | null;
  maxSlippageBps: number;
  deadline: number;
  destinationTag: number;
  xrplTxHash: string | null;
  flareTxHash: string | null;
  attestationRequest: string | null;
  votingRound: number | null;
  attempts: number;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  settledAt: number | null;
}

export interface IntentEvent {
  id: number;
  intentId: string;
  kind: string;
  message: string;
  txHash: string | null;
  explorerUrl: string | null;
  createdAt: number;
}

export interface DepositInstructions {
  destination: string;
  destinationTag: number;
  amountDrops: string;
  amountXrp: string;
  memoHex: string;
  transaction: Record<string, unknown>;
}

export interface IntentDetail {
  intent: IntentRecord;
  events: IntentEvent[];
  links: {xrplTx: string | null; flareTx: string | null};
  depositInstructions: DepositInstructions | null;
}

export interface PriceSnapshot {
  symbol: string;
  feedId: string;
  price: string;
  priceWad: string;
  decimals: number;
  timestamp: number;
  ageMs: number;
}

export interface QuoteResult {
  sourceChain: number;
  sourceAmount: string;
  sourceSymbol: string;
  destinationToken: string;
  destinationSymbol: string;
  expectedOutput: string;
  ammOutput: string;
  minimumOutput: string;
  protocolFee: string;
  priceImpactBps: number;
  rate: string;
  maxSlippageBps: number;
}

export interface TokenInfo {
  address: string;
  symbol: string;
  decimals: number;
  /** Null for the FAsset itself, which is delivered without an AMM hop. */
  pool?: string | null;
  isFAsset?: boolean;
}

export interface AppConfig {
  chainId: number;
  rpcUrl: string;
  contracts: {
    intentManager: string;
    intentSettler: string;
    priceOracle: string;
    minter: string;
  };
  explorers: Record<string, string>;
  fxrp: string;
  /** Every destination the contracts will accept, in display order. */
  tokens: TokenInfo[];
  xrpl: {
    depositAddress: string;
    depositAddressHash: string | null;
    sourceId: string;
    network: "testnet" | "mainnet";
  };
  relayerEnabled: boolean;
  usesFAssets: boolean;
}

export interface PoolStats {
  address: string;
  token0: TokenInfo & {reserve: string};
  token1: TokenInfo & {reserve: string};
  totalSupply: string;
  swapFeeBps: number;
  swapCount: number;
  cumulativeVolume0: string;
  cumulativeVolume1: string;
  tvlUsd: string;
  spotPrice0In1: string;
}

export interface ProtocolStats {
  totalIntents: number;
  settledIntents: number;
  pendingIntents: number;
  failedIntents: number;
  intentsToday: number;
  totalVolumeXrp: string;
  totalVolumeUsd: string;
  averageSettlementSeconds: number | null;
  successRatePct: number;
}

export type ServerMessage =
  | {type: "prices"; data: PriceSnapshot[]}
  | {type: "intent"; data: IntentRecord}
  | {type: "intent:event"; data: IntentEvent}
  | {type: "stats"; data: ProtocolStats}
  | {type: "hello"; data: {chainId: number; time: number}};
