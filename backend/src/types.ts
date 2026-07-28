/** Shared shapes for the relayer, the API and the WebSocket feed. */

/**
 * Relayer-side lifecycle. This is a superset of the on-chain `IntentStatus`: the extra states
 * describe where a deposit is inside the FDC pipeline, which the chain has no view of until the
 * settlement transaction lands.
 */
export type IntentStatus =
  | "PENDING" // created on Flare, waiting for the XRPL deposit
  | "DEPOSITED" // XRPL payment seen and validated
  | "ATTESTATION_REQUESTED" // attestation request submitted to FdcHub
  | "ATTESTATION_READY" // voting round finalised, Merkle proof retrieved
  | "SETTLING" // settlement transaction submitted to Flare
  | "SETTLED" // output token delivered
  | "EXPIRED" // deadline passed with no valid deposit
  | "CANCELLED" // cancelled by the user before depositing
  | "FAILED"; // settlement reverted; see `error`

export const TERMINAL_STATUSES: readonly IntentStatus[] = ["SETTLED", "EXPIRED", "CANCELLED"];

/** The six steps the /intent/[id] progress stepper renders. */
export const PROGRESS_STEPS = [
  "Intent Created",
  "XRP Deposited",
  "FDC Verified",
  "FXRP Minted",
  "Swapped",
  "Delivered",
] as const;

export interface IntentRecord {
  intentId: string;
  userAddress: string;
  status: IntentStatus;
  sourceChain: number;
  sourceToken: string;
  sourceAmount: string; // base units (drops), as a decimal string
  destinationToken: string;
  destinationSymbol: string;
  minOutputAmount: string;
  outputAmount: string | null;
  maxSlippageBps: number;
  deadline: number; // unix seconds
  destinationTag: number;
  xrplTxHash: string | null;
  flareTxHash: string | null;
  attestationRequest: string | null; // ABI-encoded FDC request
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

export interface PriceSnapshot {
  symbol: string;
  feedId: string;
  /** Decimal string, e.g. "0.62480". */
  price: string;
  /** 18-decimal integer string, for exact maths on the client. */
  priceWad: string;
  decimals: number;
  timestamp: number;
  /** Milliseconds since the backend last refreshed this feed. */
  ageMs: number;
}

export interface QuoteResult {
  sourceChain: number;
  sourceAmount: string;
  sourceSymbol: string;
  destinationToken: string;
  destinationSymbol: string;
  /** FTSO fair value, net of the protocol fee. */
  expectedOutput: string;
  /** What the AMM would actually pay right now. */
  ammOutput: string;
  /** The floor `IntentSettler` will enforce at `maxSlippageBps`. */
  minimumOutput: string;
  protocolFee: string;
  priceImpactBps: number;
  /** Whole destination units per whole source unit. */
  rate: string;
  maxSlippageBps: number;
}

export interface PoolStats {
  address: string;
  token0: {address: string; symbol: string; decimals: number; reserve: string};
  token1: {address: string; symbol: string; decimals: number; reserve: string};
  totalSupply: string;
  swapFeeBps: number;
  swapCount: number;
  cumulativeVolume0: string;
  cumulativeVolume1: string;
  /** USD notional of both reserves, from FTSO. */
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

/** Messages pushed over `/ws`. */
export type ServerMessage =
  | {type: "prices"; data: PriceSnapshot[]}
  | {type: "intent"; data: IntentRecord}
  | {type: "intent:event"; data: IntentEvent}
  | {type: "stats"; data: ProtocolStats}
  | {type: "hello"; data: {chainId: number; time: number}};
