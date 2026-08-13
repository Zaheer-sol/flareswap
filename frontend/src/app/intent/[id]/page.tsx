"use client";

import {use, useState} from "react";
import Link from "next/link";
import {useAppConfig, useLiveIntent, useNow} from "@/lib/hooks";
import {useWallet} from "@/lib/wallet";
import {useToast} from "@/components/Toast";
import {ProgressStepper} from "@/components/ProgressStepper";
import {StatusBadge, isActive} from "@/components/StatusBadge";
import {DepositInstructions} from "@/components/DepositInstructions";
import {
  AddressChip,
  CopyButton,
  DetailRow,
  ErrorState,
  ExternalLink,
  PageHeader,
  Section,
  Spinner,
} from "@/components/ui";
import {api} from "@/lib/api";
import {intentManagerWrite, describeContractError} from "@/lib/contracts";
import {DEFAULT_CHAIN_ID, chainInfo, explorerAddressUrl, explorerTxUrl} from "@/lib/constants";
import {
  formatAmount,
  formatBps,
  formatDateTime,
  formatDuration,
  formatRelativeTime,
  shortHash,
} from "@/lib/format";
import type {IntentEvent, IntentRecord} from "@/lib/types";

export default function IntentPage({params}: {params: Promise<{id: string}>}) {
  const {id} = use(params);
  const {intent, events, depositInstructions, loading, error, reload} = useLiveIntent(id);
  const {data: config} = useAppConfig();

  if (loading && !intent) {
    return (
      <div className="mx-auto max-w-3xl space-y-4">
        <div className="skeleton h-8 w-64" />
        <div className="card h-40" />
        <div className="card h-64" />
      </div>
    );
  }

  if (error && !intent) {
    return (
      <div className="mx-auto max-w-3xl">
        <ErrorState
          message={
            error.includes("not found")
              ? "No intent with that id. It may not have been indexed yet. The backend catches up within a few seconds of creation."
              : error
          }
          onRetry={reload}
        />
        <div className="mt-4">
          <Link href="/swap" className="btn-secondary">
            Create a new intent
          </Link>
        </div>
      </div>
    );
  }

  if (!intent) return null;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader
        eyebrow="Intent"
        title={`${formatAmount(intent.sourceAmount, 6, 4)} XRP → ${intent.destinationSymbol}`}
        description={
          <span className="mono break-all text-xs text-slate-500">
            {intent.intentId} <CopyButton value={intent.intentId} />
          </span>
        }
        actions={<StatusBadge status={intent.status} />}
      />

      <ProgressStepper status={intent.status} />

      {intent.status === "PENDING" && config && depositInstructions ? (
        <DepositInstructions instructions={depositInstructions} network={config.xrpl.network} />
      ) : null}

      {intent.status === "FAILED" && intent.error ? (
        <div className="card border-flare-700/40 bg-flare-900/10 p-4">
          <p className="text-sm font-semibold text-flare-200">Settlement failed</p>
          <p className="mono mt-1 break-words text-xs text-slate-400">{intent.error}</p>
          <p className="mt-2 text-xs text-slate-500">
            The relayer retries automatically ({intent.attempts} attempt
            {intent.attempts === 1 ? "" : "s"} so far). Your deposit is not lost. Settlement is
            atomic, so a failed attempt changes nothing on-chain.
          </p>
          <RetryButton intentId={intent.intentId} onDone={reload} />
        </div>
      ) : null}

      <div className="grid gap-6 md:grid-cols-2">
        <Terms intent={intent} />
        <Timeline events={events} intent={intent} />
      </div>

      <Actions intent={intent} onChanged={reload} />
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function Terms({intent}: {intent: IntentRecord}) {
  const now = useNow(1_000);
  const remaining = intent.deadline - Math.floor(now / 1000);

  return (
    <Section title="Terms" description="Committed on-chain before you deposited">
      <div className="card divide-y divide-white/5 px-4 py-1">
        <DetailRow label="You send">
          <span className="tabular">{formatAmount(intent.sourceAmount, 6, 6)} XRP</span>
        </DetailRow>

        <DetailRow label="You receive">
          {intent.outputAmount ? (
            <span className="tabular font-semibold text-mint-400">
              {formatAmount(intent.outputAmount, 6, 6)} {intent.destinationSymbol}
            </span>
          ) : (
            <span className="text-slate-500">{intent.destinationSymbol} · pending</span>
          )}
        </DetailRow>

        <DetailRow label="Minimum output" hint="Absolute floor written into the intent">
          <span className="tabular">
            {formatAmount(intent.minOutputAmount, 6, 4)} {intent.destinationSymbol}
          </span>
        </DetailRow>

        <DetailRow label="Max slippage" hint="Checked against FTSO at settlement time">
          {formatBps(intent.maxSlippageBps)}
        </DetailRow>

        <DetailRow label="Destination tag">
          <span className="tabular">{intent.destinationTag}</span>
        </DetailRow>

        <DetailRow label="Deadline">
          {isActive(intent.status) ? (
            <span className={remaining < 300 ? "text-flare-300" : "text-slate-300"}>
              {remaining > 0 ? `in ${formatDuration(remaining)}` : "passed"}
            </span>
          ) : (
            <span className="text-slate-500">{formatDateTime(intent.deadline)}</span>
          )}
        </DetailRow>

        <DetailRow label="Created">{formatDateTime(intent.createdAt)}</DetailRow>

        {intent.settledAt ? (
          <DetailRow label="Settled in">
            <span className="text-mint-400">{formatDuration(intent.settledAt - intent.createdAt)}</span>
          </DetailRow>
        ) : null}

        <DetailRow label="Recipient">
          <AddressChip
            address={intent.userAddress}
            href={explorerAddressUrl(DEFAULT_CHAIN_ID, intent.userAddress) ?? undefined}
          />
        </DetailRow>

        {intent.votingRound ? (
          <DetailRow label="FDC voting round" hint="The round whose Merkle root proves your deposit">
            <span className="tabular verified">{intent.votingRound}</span>
          </DetailRow>
        ) : null}
      </div>
    </Section>
  );
}

function Timeline({events, intent}: {events: IntentEvent[]; intent: IntentRecord}) {
  return (
    <Section title="Activity" description="Every step, with links to both chains">
      <div className="card p-4">
        {events.length === 0 ? (
          <p className="py-6 text-center text-xs text-slate-600">No activity recorded yet.</p>
        ) : (
          <ol className="space-y-3">
            {events.map((event, index) => (
              <li key={event.id} className="flex gap-3">
                <div className="flex flex-col items-center">
                  <span
                    className={`mt-1 h-2 w-2 shrink-0 rounded-full ${
                      event.kind === "error" ? "bg-flare-400" : "bg-verify-400"
                    }`}
                  />
                  {index < events.length - 1 ? <span className="w-px flex-1 bg-white/10" /> : null}
                </div>
                <div className="min-w-0 flex-1 pb-1">
                  <p className="text-xs text-slate-300">{event.message}</p>
                  <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[11px] text-slate-600">
                    <span>{formatRelativeTime(event.createdAt)}</span>
                    {event.explorerUrl && event.txHash ? (
                      <ExternalLink href={event.explorerUrl} className="text-[11px]">
                        {shortHash(event.txHash)}
                      </ExternalLink>
                    ) : null}
                  </div>
                </div>
              </li>
            ))}
          </ol>
        )}

        {isActive(intent.status) ? (
          <p className="mt-4 flex items-center gap-2 border-t border-white/5 pt-3 text-[11px] text-slate-500">
            <Spinner className="h-3 w-3" />
            Live: this page updates as the relayer progresses.
          </p>
        ) : null}
      </div>
    </Section>
  );
}

function Actions({intent, onChanged}: {intent: IntentRecord; onChanged: () => void}) {
  const wallet = useWallet();
  const {data: config} = useAppConfig();
  const toast = useToast();
  const [cancelling, setCancelling] = useState(false);

  const isOwner = wallet.address?.toLowerCase() === intent.userAddress.toLowerCase();
  const canCancel = isOwner && intent.status === "PENDING";

  async function cancel(): Promise<void> {
    if (!config) return;
    setCancelling(true);
    const pending = toast.push({kind: "pending", title: "Cancelling intent"});
    try {
      const signer = await wallet.getSigner();
      const manager = intentManagerWrite(config, signer);
      const tx = await manager.cancelIntent(intent.intentId);
      await tx.wait();
      toast.update(pending, {
        kind: "success",
        title: "Intent cancelled",
        href: explorerTxUrl(DEFAULT_CHAIN_ID, tx.hash) ?? undefined,
      });
      onChanged();
    } catch (error) {
      toast.update(pending, {kind: "error", title: "Could not cancel", body: describeContractError(error)});
    } finally {
      setCancelling(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      {intent.xrplTxHash ? (
        <ExternalLink
          href={
            config?.xrpl.network === "mainnet"
              ? `https://livenet.xrpl.org/transactions/${intent.xrplTxHash}`
              : `https://testnet.xrpl.org/transactions/${intent.xrplTxHash}`
          }
          className="btn-secondary"
        >
          XRPL deposit
        </ExternalLink>
      ) : null}

      {intent.flareTxHash ? (
        <ExternalLink
          href={explorerTxUrl(DEFAULT_CHAIN_ID, intent.flareTxHash) ?? "#"}
          className="btn-secondary"
        >
          Settlement on Flare
        </ExternalLink>
      ) : null}

      {canCancel ? (
        <button type="button" onClick={() => void cancel()} disabled={cancelling} className="btn-ghost">
          {cancelling ? "Cancelling…" : "Cancel intent"}
        </button>
      ) : null}

      <Link href="/dashboard" className="btn-ghost ml-auto">
        All my intents →
      </Link>
    </div>
  );
}

function RetryButton({intentId, onDone}: {intentId: string; onDone: () => void}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  return (
    <button
      type="button"
      disabled={busy}
      onClick={() => {
        setBusy(true);
        void api
          .retryIntent(intentId)
          .then(() => {
            toast.push({kind: "info", title: "Retry queued", body: "The relayer will try again now."});
            onDone();
          })
          .catch((error: Error) =>
            toast.push({kind: "error", title: "Retry failed", body: error.message}),
          )
          .finally(() => setBusy(false));
      }}
      className="btn-secondary mt-3"
    >
      {busy ? "Retrying…" : "Retry now"}
    </button>
  );
}
