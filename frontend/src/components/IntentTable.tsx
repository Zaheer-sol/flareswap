"use client";

import Link from "next/link";
import {StatusBadge} from "./StatusBadge";
import {EmptyState} from "./ui";
import {formatAmount, formatRelativeTime, shortHash} from "@/lib/format";
import type {IntentRecord} from "@/lib/types";

/**
 * Shared intent list, used by both the dashboard and the public explorer.
 *
 * `anonymise` truncates recipient addresses on the explorer: the data is public on-chain
 * regardless, but a public feed should not make it trivially scrapable into a wallet-activity
 * profile.
 */
export function IntentTable({
  intents,
  anonymise = false,
  emptyTitle = "No intents yet",
  emptyDescription,
  emptyAction,
}: {
  intents: IntentRecord[];
  anonymise?: boolean;
  emptyTitle?: string;
  emptyDescription?: string;
  emptyAction?: React.ReactNode;
}) {
  if (intents.length === 0) {
    return <EmptyState title={emptyTitle} description={emptyDescription} action={emptyAction} />;
  }

  return (
    <div className="card overflow-hidden">
      {/* Desktop: real table. */}
      <table className="hidden w-full text-left text-sm sm:table">
        <thead>
          <tr className="border-b border-white/5 text-xs">
            <th scope="col" className="label px-4 py-3 font-medium">
              Intent
            </th>
            <th scope="col" className="label px-4 py-3 font-medium">
              Send
            </th>
            <th scope="col" className="label px-4 py-3 font-medium">
              Receive
            </th>
            <th scope="col" className="label px-4 py-3 font-medium">
              Status
            </th>
            <th scope="col" className="label px-4 py-3 text-right font-medium">
              Age
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-white/5">
          {intents.map((intent) => (
            <tr key={intent.intentId} className="transition-colors hover:bg-white/[0.02]">
              <td className="px-4 py-3">
                <Link
                  href={`/intent/${intent.intentId}`}
                  className="mono text-xs text-flare-300 hover:text-flare-200"
                >
                  {shortHash(intent.intentId, 8)}
                </Link>
                {!anonymise ? null : (
                  <p className="mono mt-0.5 text-[10px] text-slate-600">
                    {shortHash(intent.userAddress, 4)}
                  </p>
                )}
              </td>
              <td className="tabular px-4 py-3 text-slate-200">
                {formatAmount(intent.sourceAmount, 6, 4)}{" "}
                <span className="text-slate-500">{intent.sourceToken}</span>
              </td>
              <td className="tabular px-4 py-3">
                {intent.outputAmount ? (
                  <span className="text-mint-400">
                    {formatAmount(intent.outputAmount, 6, 4)}{" "}
                    <span className="text-slate-500">{intent.destinationSymbol}</span>
                  </span>
                ) : (
                  <span className="text-slate-600">— {intent.destinationSymbol}</span>
                )}
              </td>
              <td className="px-4 py-3">
                <StatusBadge status={intent.status} />
              </td>
              <td className="px-4 py-3 text-right text-xs text-slate-500">
                {formatRelativeTime(intent.createdAt)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* Mobile: a table would need horizontal scroll, so stack into cards instead. */}
      <ul className="divide-y divide-white/5 sm:hidden">
        {intents.map((intent) => (
          <li key={intent.intentId}>
            <Link href={`/intent/${intent.intentId}`} className="block px-4 py-3.5 active:bg-white/5">
              <div className="flex items-center justify-between gap-3">
                <span className="mono text-xs text-flare-300">{shortHash(intent.intentId, 6)}</span>
                <StatusBadge status={intent.status} />
              </div>
              <div className="tabular mt-2 flex items-center gap-2 text-sm">
                <span className="text-slate-200">
                  {formatAmount(intent.sourceAmount, 6, 4)} {intent.sourceToken}
                </span>
                <span className="text-slate-600">→</span>
                <span className={intent.outputAmount ? "text-mint-400" : "text-slate-600"}>
                  {intent.outputAmount ? formatAmount(intent.outputAmount, 6, 4) : "—"}{" "}
                  {intent.destinationSymbol}
                </span>
              </div>
              <p className="mt-1 text-[11px] text-slate-600">{formatRelativeTime(intent.createdAt)}</p>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
