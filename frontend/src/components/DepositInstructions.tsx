"use client";

import {useEffect, useState} from "react";
import QRCode from "qrcode";
import {CopyButton, ExternalLink} from "./ui";
import {dropsToXrp} from "@/lib/format";
import type {DepositInstructions as Instructions} from "@/lib/types";

/**
 * The XRPL payment the user must sign, spelled out exactly.
 *
 * The 32-byte memo is not optional decoration — it *is* the binding between the payment and the
 * intent. The FDC reports it as `standardPaymentReference`, and `IntentSettler` refuses to
 * settle anything whose reference does not equal the intent id. A payment without it is not
 * recoverable on-chain, only by hand. Hence the warning, and hence the raw transaction JSON: it
 * is the one form every XRPL wallet can consume without dropping fields.
 */
export function DepositInstructions({
  instructions,
  network,
}: {
  instructions: Instructions;
  network: "testnet" | "mainnet";
}) {
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [showRaw, setShowRaw] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void QRCode.toDataURL(instructions.destination, {
      width: 320,
      margin: 1,
      color: {dark: "#e2e8f0", light: "#0b0f1c"},
      errorCorrectionLevel: "M",
    })
      .then((url) => {
        if (!cancelled) setQrDataUrl(url);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [instructions.destination]);

  const rawTransaction = JSON.stringify(
    {...instructions.transaction, Account: "<your XRPL address>"},
    null,
    2,
  );

  const explorer =
    network === "testnet"
      ? `https://testnet.xrpl.org/accounts/${instructions.destination}`
      : `https://livenet.xrpl.org/accounts/${instructions.destination}`;

  return (
    <div className="card overflow-hidden">
      <div className="border-b border-white/5 bg-flare-500/[0.06] px-5 py-4">
        <p className="text-sm font-semibold text-white">Send exactly this payment on XRPL</p>
        <p className="mt-0.5 text-xs text-slate-400">
          Your intent is live on Flare. It settles as soon as this deposit is attested.
        </p>
      </div>

      <div className="grid gap-6 p-5 sm:grid-cols-[auto,1fr] sm:p-6">
        <div className="mx-auto flex flex-col items-center gap-2 sm:mx-0">
          <div className="rounded-xl border border-white/10 bg-ink-950 p-2">
            {qrDataUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={qrDataUrl}
                alt={`QR code for XRPL address ${instructions.destination}`}
                className="h-40 w-40"
              />
            ) : (
              <div className="skeleton h-40 w-40" />
            )}
          </div>
          <p className="max-w-[10rem] text-center text-[10px] leading-tight text-slate-600">
            Address only — the tag and memo must be entered manually
          </p>
        </div>

        <dl className="space-y-3">
          <Field label="Destination address" value={instructions.destination} mono>
            <ExternalLink href={explorer} className="text-[11px]">
              view on XRPL
            </ExternalLink>
          </Field>

          <Field
            label="Amount"
            value={instructions.amountDrops}
            display={`${dropsToXrp(instructions.amountDrops)} XRP`}
            hint={`${instructions.amountDrops} drops`}
          />

          <Field
            label="Destination tag"
            value={String(instructions.destinationTag)}
            hint="Identifies your intent if the memo is lost"
          />

          <Field
            label="Memo (MemoData)"
            value={instructions.memoHex}
            mono
            required
            hint="32-byte hex — this is what binds the payment to your intent"
          />
        </dl>
      </div>

      <div className="border-t border-white/5 bg-flare-900/10 px-5 py-3.5">
        <p className="text-xs leading-relaxed text-flare-200">
          <span className="font-semibold">The memo is required.</span>{" "}
          <span className="text-slate-400">
            The Flare Data Connector reports it as the payment reference, and the settler will
            reject any deposit whose reference does not match this intent. A payment sent without
            it can only be refunded manually.
          </span>
        </p>
      </div>

      <div className="border-t border-white/5 px-5 py-3.5">
        <button
          type="button"
          onClick={() => setShowRaw((open) => !open)}
          className="flex w-full items-center justify-between text-xs font-medium text-slate-400 hover:text-slate-200"
          aria-expanded={showRaw}
        >
          <span>Raw transaction JSON (for Xaman / GemWallet raw signing)</span>
          <span aria-hidden>{showRaw ? "−" : "+"}</span>
        </button>

        {showRaw ? (
          <div className="mt-3">
            <pre className="mono max-h-64 overflow-auto rounded-lg border border-white/5 bg-ink-950 p-3 text-[11px] leading-relaxed text-slate-300">
              {rawTransaction}
            </pre>
            <div className="mt-2 flex justify-end">
              <CopyButton value={rawTransaction} label="Copy JSON" />
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  display,
  hint,
  mono,
  required,
  children,
}: {
  label: string;
  value: string;
  display?: string;
  hint?: string;
  mono?: boolean;
  required?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-white/5 bg-ink-950/50 px-3.5 py-3">
      <div className="flex items-center justify-between gap-2">
        <dt className="label flex items-center gap-1.5">
          {label}
          {required ? <span className="text-flare-400">*</span> : null}
        </dt>
        <div className="flex items-center gap-2">
          {children}
          <CopyButton value={value} />
        </div>
      </div>
      <dd
        className={`mt-1 break-all text-sm text-slate-100 ${mono ? "mono" : "tabular font-semibold"}`}
      >
        {display ?? value}
      </dd>
      {hint ? <p className="mt-1 text-[11px] text-slate-600">{hint}</p> : null}
    </div>
  );
}
