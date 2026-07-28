"use client";

import {PROGRESS_STEPS} from "@/lib/constants";
import type {IntentStatus} from "@/lib/types";

/**
 * Maps relayer status onto the six user-visible steps.
 *
 * The mapping is coarse on purpose. "FDC Verified", "FXRP Minted" and "Swapped" all happen
 * inside a single `settleIntent` transaction, so there is no on-chain moment between them to
 * observe — showing them as separate steps is honest about *what happens*, and they light up
 * together when the transaction confirms.
 */
const STEP_INDEX: Record<IntentStatus, number> = {
  PENDING: 0,
  DEPOSITED: 1,
  ATTESTATION_REQUESTED: 1,
  ATTESTATION_READY: 2,
  SETTLING: 3,
  SETTLED: 5,
  EXPIRED: -1,
  CANCELLED: -1,
  FAILED: -2,
};

export function ProgressStepper({status}: {status: IntentStatus}) {
  const current = STEP_INDEX[status] ?? 0;
  const halted = current < 0;
  const settled = status === "SETTLED";

  return (
    <div className="card p-5 sm:p-6">
      <ol className="flex flex-col gap-0 sm:flex-row sm:gap-0">
        {PROGRESS_STEPS.map((step, index) => {
          const done = settled || index < current;
          const active = !halted && !settled && index === current;
          const isLast = index === PROGRESS_STEPS.length - 1;

          return (
            <li key={step.key} className="flex flex-1 gap-3 sm:flex-col sm:gap-0">
              {/* marker + connector */}
              <div className="flex flex-col items-center sm:w-full sm:flex-row">
                <Marker done={done} active={active} halted={halted} index={index} />
                {!isLast ? (
                  <span
                    className={`w-px flex-1 sm:h-px sm:w-full ${
                      done ? "bg-mint-500/50" : "bg-white/10"
                    }`}
                    aria-hidden
                  />
                ) : null}
              </div>

              <div className="pb-6 sm:pb-0 sm:pr-4 sm:pt-3">
                <p
                  className={`text-xs font-semibold ${
                    done ? "text-mint-300" : active ? "text-flare-200" : "text-slate-500"
                  }`}
                >
                  {step.label}
                </p>
                <p className="mt-0.5 text-[11px] leading-tight text-slate-600">{step.detail}</p>
              </div>
            </li>
          );
        })}
      </ol>

      {halted ? (
        <p className="mt-2 rounded-lg border border-white/5 bg-white/5 px-3 py-2 text-xs text-slate-400">
          {status === "FAILED"
            ? "Settlement failed. The relayer will retry; the deposit is not lost."
            : status === "EXPIRED"
              ? "This intent passed its deadline without a valid deposit."
              : "This intent was cancelled before any deposit arrived."}
        </p>
      ) : null}
    </div>
  );
}

function Marker({
  done,
  active,
  halted,
  index,
}: {
  done: boolean;
  active: boolean;
  halted: boolean;
  index: number;
}) {
  const base =
    "relative flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-[11px] font-bold transition-colors";

  if (done) {
    return (
      <span className={`${base} border-mint-500/50 bg-mint-500/15 text-mint-300`} aria-label="complete">
        ✓
      </span>
    );
  }
  if (active) {
    return (
      <span className={`${base} border-flare-500/60 bg-flare-500/15 text-flare-200`} aria-current="step">
        <span className="absolute inline-flex h-full w-full animate-pulse-ring rounded-full bg-flare-500/40" />
        <span className="relative">{index + 1}</span>
      </span>
    );
  }
  return (
    <span className={`${base} ${halted ? "border-white/5 text-slate-700" : "border-white/10 text-slate-600"}`}>
      {index + 1}
    </span>
  );
}
