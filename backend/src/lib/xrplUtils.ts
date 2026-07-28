import {keccak256, toUtf8Bytes, hexlify, getBytes} from "ethers";

/**
 * The FDC's standard address hash: `keccak256(bytes(standardAddress))`.
 *
 * This is the single most failure-prone constant in the whole system. `IntentSettler` compares
 * the hash it was configured with against `receivingAddressHash` in the proof, so the deploy
 * script, this backend and the FDC must all agree byte for byte. Case-insensitive address
 * formats (Bitcoin bech32) must be lowercased first; XRPL base58 addresses are case-sensitive
 * and used as-is.
 */
export function standardAddressHash(address: string): string {
  return keccak256(toUtf8Bytes(address));
}

/**
 * XRPL memo encoding for a FlareSwap deposit.
 *
 * The FDC only accepts a payment reference when the transaction carries exactly one Memo whose
 * `MemoData` is a hex string of precisely 32 bytes. We put the `intentId` there, which is what
 * binds the deposit to the terms the user signed for.
 */
export function encodeIntentMemo(intentId: string): string {
  const bytes = getBytes(intentId);
  if (bytes.length !== 32) {
    throw new Error(`intentId must be 32 bytes, got ${bytes.length}`);
  }
  // XRPL expects uppercase hex without the 0x prefix.
  return hexlify(bytes).slice(2).toUpperCase();
}

/** Inverse of {@link encodeIntentMemo}; returns null when the memo is not a 32-byte reference. */
export function decodeIntentMemo(memoData: string | undefined): string | null {
  if (!memoData) return null;
  const clean = memoData.startsWith("0x") ? memoData.slice(2) : memoData;
  if (clean.length !== 64 || !/^[0-9a-fA-F]{64}$/.test(clean)) return null;
  return `0x${clean.toLowerCase()}`;
}

/** Builds the unsigned XRPL Payment the frontend hands to Xaman/GemWallet. */
export function buildDepositTransaction(params: {
  account: string;
  destination: string;
  amountDrops: string;
  intentId: string;
  destinationTag: number;
}): Record<string, unknown> {
  return {
    TransactionType: "Payment",
    Account: params.account,
    Destination: params.destination,
    // XRPL `Amount` as a bare string means drops.
    Amount: params.amountDrops,
    DestinationTag: params.destinationTag,
    Memos: [
      {
        Memo: {
          MemoData: encodeIntentMemo(params.intentId),
        },
      },
    ],
  };
}

/** 1 XRP = 1,000,000 drops. */
export function xrpToDrops(xrp: string | number): string {
  const [whole, fraction = ""] = String(xrp).split(".");
  const padded = (fraction + "000000").slice(0, 6);
  return (BigInt(whole || "0") * 1_000_000n + BigInt(padded || "0")).toString();
}

export function dropsToXrp(drops: string | bigint): string {
  const value = BigInt(drops);
  const whole = value / 1_000_000n;
  const fraction = (value % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

/**
 * A validated XRPL Payment into the deposit address, normalised for the relayer.
 * `amountDrops` is null for non-XRP (issued-currency) payments, which we ignore.
 */
export interface ObservedDeposit {
  txHash: string;
  ledgerIndex: number;
  account: string;
  destination: string;
  destinationTag: number | null;
  amountDrops: string | null;
  intentId: string | null;
}

interface XrplMemo {
  Memo?: {MemoData?: string};
}

interface XrplPaymentLike {
  hash?: string;
  TransactionType?: string;
  Account?: string;
  Destination?: string;
  DestinationTag?: number;
  Amount?: unknown;
  Memos?: XrplMemo[];
  [key: string]: unknown;
}

/**
 * Extracts a deposit from a raw XRPL transaction.
 *
 * Uses `delivered_amount` from the metadata rather than the transaction's `Amount` field:
 * partial payments can deliver less than `Amount` says, and the FDC (correctly) attests to what
 * was actually delivered. Trusting `Amount` here would make the relayer request attestations
 * that then fail the settler's `DepositTooSmall` check.
 */
export function parseDeposit(
  tx: XrplPaymentLike,
  meta: {delivered_amount?: unknown; DeliveredAmount?: unknown; TransactionResult?: string} | undefined,
  ledgerIndex: number,
  txHash: string,
): ObservedDeposit | null {
  if (tx.TransactionType !== "Payment") return null;
  if (meta?.TransactionResult && meta.TransactionResult !== "tesSUCCESS") return null;

  const delivered = meta?.delivered_amount ?? meta?.DeliveredAmount ?? tx.Amount;
  const amountDrops = typeof delivered === "string" ? delivered : null;

  const memoData = tx.Memos?.[0]?.Memo?.MemoData;
  const hexMemo = memoData ? hexOrUtf8(memoData) : undefined;

  return {
    txHash,
    ledgerIndex,
    account: String(tx.Account ?? ""),
    destination: String(tx.Destination ?? ""),
    destinationTag: typeof tx.DestinationTag === "number" ? tx.DestinationTag : null,
    amountDrops,
    intentId: decodeIntentMemo(hexMemo),
  };
}

/**
 * Wallets are inconsistent about whether MemoData arrives as hex or as a UTF-8 string that
 * happens to contain hex. Normalise both to plain hex before decoding.
 */
function hexOrUtf8(memoData: string): string {
  const clean = memoData.startsWith("0x") ? memoData.slice(2) : memoData;
  if (clean.length === 64 && /^[0-9a-fA-F]+$/.test(clean)) return clean;

  // 66 hex chars decodes to a 33-char ASCII string — a "0x"-prefixed reference typed as text.
  try {
    const decoded = Buffer.from(clean, "hex").toString("utf8");
    if (/^0x[0-9a-fA-F]{64}$/.test(decoded)) return decoded.slice(2);
  } catch {
    /* not valid hex; fall through */
  }
  return clean;
}
