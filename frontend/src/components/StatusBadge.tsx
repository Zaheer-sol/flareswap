import type {IntentStatus} from "@/lib/types";

const STATUS_META: Record<IntentStatus, {label: string; className: string; pulse?: boolean}> = {
  PENDING: {
    label: "Awaiting deposit",
    className: "border-amber-500/30 bg-amber-500/10 text-amber-300",
    pulse: true,
  },
  DEPOSITED: {
    label: "Deposit seen",
    className: "border-verify-500/30 bg-verify-500/10 text-verify-300",
    pulse: true,
  },
  ATTESTATION_REQUESTED: {
    label: "FDC attesting",
    className: "border-verify-500/30 bg-verify-500/10 text-verify-300",
    pulse: true,
  },
  ATTESTATION_READY: {
    label: "Proof ready",
    className: "border-verify-500/40 bg-verify-500/15 text-verify-200",
    pulse: true,
  },
  SETTLING: {
    label: "Settling",
    className: "border-flare-500/40 bg-flare-500/10 text-flare-300",
    pulse: true,
  },
  SETTLED: {label: "Settled", className: "border-mint-500/30 bg-mint-500/10 text-mint-400"},
  EXPIRED: {label: "Expired", className: "border-white/10 bg-white/5 text-slate-500"},
  CANCELLED: {label: "Cancelled", className: "border-white/10 bg-white/5 text-slate-500"},
  FAILED: {label: "Failed", className: "border-flare-600/40 bg-flare-900/30 text-flare-300"},
};

export function StatusBadge({status, className = ""}: {status: IntentStatus; className?: string}) {
  const meta = STATUS_META[status] ?? STATUS_META.PENDING;

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${meta.className} ${className}`}
    >
      {meta.pulse ? (
        <span className="relative flex h-1.5 w-1.5">
          <span className="absolute inline-flex h-full w-full animate-pulse-ring rounded-full bg-current" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-current" />
        </span>
      ) : (
        <span className="h-1.5 w-1.5 rounded-full bg-current" />
      )}
      {meta.label}
    </span>
  );
}

export function statusLabel(status: IntentStatus): string {
  return STATUS_META[status]?.label ?? status;
}

/** True while the relayer is still expected to move this intent along. */
export function isActive(status: IntentStatus): boolean {
  return !["SETTLED", "EXPIRED", "CANCELLED"].includes(status);
}
