import {formatUnits, parseUnits} from "ethers";

/** Formats a base-unit bigint for display, trimming trailing zeros. */
export function formatAmount(
  value: string | bigint | null | undefined,
  decimals: number,
  maxFractionDigits = 6,
): string {
  if (value === null || value === undefined || value === "") return "0";
  try {
    const whole = formatUnits(BigInt(value), decimals);
    const [integer, fraction = ""] = whole.split(".");
    const trimmed = fraction.slice(0, maxFractionDigits).replace(/0+$/, "");
    const grouped = Number(integer).toLocaleString("en-US");
    return trimmed ? `${grouped}.${trimmed}` : grouped;
  } catch {
    return "0";
  }
}

/** Parses user input into base units, tolerating an empty or partial value mid-typing. */
export function parseAmount(input: string, decimals: number): bigint {
  const clean = input.trim();
  if (!clean || clean === "." || Number.isNaN(Number(clean))) return 0n;
  try {
    // Extra precision is truncated rather than rejected, so typing "0.1234567" in a 6-dp field
    // does not throw on every keystroke.
    const [integer, fraction = ""] = clean.split(".");
    return parseUnits(`${integer || "0"}.${fraction.slice(0, decimals) || "0"}`, decimals);
  } catch {
    return 0n;
  }
}

export function formatUsd(value: string | number | null | undefined, digits = 2): string {
  const numeric = typeof value === "string" ? Number(value) : (value ?? 0);
  if (!Number.isFinite(numeric)) return "$0.00";
  if (Math.abs(numeric) >= 1_000_000) return `$${(numeric / 1_000_000).toFixed(2)}M`;
  if (Math.abs(numeric) >= 10_000) return `$${Math.round(numeric).toLocaleString("en-US")}`;
  return `$${numeric.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}`;
}

export function formatPrice(price: string | number | null | undefined, digits = 4): string {
  const numeric = typeof price === "string" ? Number(price) : (price ?? 0);
  if (!Number.isFinite(numeric) || numeric === 0) return "-";
  if (numeric >= 1000) return numeric.toLocaleString("en-US", {maximumFractionDigits: 2});
  if (numeric >= 1) return numeric.toFixed(digits);
  // Sub-dollar assets need more precision than a fixed 4 dp gives.
  return numeric.toPrecision(4);
}

export function shortAddress(address: string | null | undefined, size = 4): string {
  if (!address) return "-";
  if (address.length <= size * 2 + 2) return address;
  return `${address.slice(0, size + 2)}…${address.slice(-size)}`;
}

export function shortHash(hash: string | null | undefined, size = 6): string {
  if (!hash) return "-";
  return hash.length <= size * 2 ? hash : `${hash.slice(0, size)}…${hash.slice(-size)}`;
}

export function formatBps(bps: number): string {
  return `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 2)}%`;
}

export function formatRelativeTime(unixSeconds: number | null | undefined): string {
  if (!unixSeconds) return "-";
  const deltaSeconds = Math.floor(Date.now() / 1000) - unixSeconds;
  if (deltaSeconds < 0) return "just now";
  if (deltaSeconds < 60) return `${deltaSeconds}s ago`;
  if (deltaSeconds < 3600) return `${Math.floor(deltaSeconds / 60)}m ago`;
  if (deltaSeconds < 86_400) return `${Math.floor(deltaSeconds / 3600)}h ago`;
  return `${Math.floor(deltaSeconds / 86_400)}d ago`;
}

export function formatDateTime(unixSeconds: number | null | undefined): string {
  if (!unixSeconds) return "-";
  return new Date(unixSeconds * 1000).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return "-";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

/** Counts down to a deadline, or reports that it has passed. */
export function formatCountdown(deadlineSeconds: number): string {
  const remaining = deadlineSeconds - Math.floor(Date.now() / 1000);
  if (remaining <= 0) return "expired";
  return formatDuration(remaining);
}

export const DROPS_PER_XRP = 1_000_000n;

export function dropsToXrp(drops: string | bigint): string {
  return formatAmount(drops, 6);
}

export function xrpToDrops(xrp: string): bigint {
  return parseAmount(xrp, 6);
}
