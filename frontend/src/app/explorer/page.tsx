"use client";

import {useState} from "react";
import {api} from "@/lib/api";
import {useAsync, useLiveMessages, usePrices, useStats} from "@/lib/hooks";
import {IntentTable} from "@/components/IntentTable";
import {PriceTicker} from "@/components/PriceTicker";
import {BackendOffline, PageHeader, Section, StatTile, Tabs} from "@/components/ui";
import {formatDuration, formatPrice, formatUsd} from "@/lib/format";
import type {IntentStatus, PriceSnapshot} from "@/lib/types";

type Filter = "all" | "settled" | "active";

const FILTER_STATUSES: Record<Filter, IntentStatus[] | undefined> = {
  all: undefined,
  settled: ["SETTLED"],
  active: ["PENDING", "DEPOSITED", "ATTESTATION_REQUESTED", "ATTESTATION_READY", "SETTLING"],
};

export default function ExplorerPage() {
  const stats = useStats();
  const [filter, setFilter] = useState<Filter>("all");
  const [bump, setBump] = useState(0);

  const {data, error, loading} = useAsync(
    () => api.intents({status: FILTER_STATUSES[filter], limit: 50}),
    [filter, bump],
  );

  useLiveMessages((message) => {
    if (message.type === "intent") setBump((value) => value + 1);
  });

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Public feed"
        title="Explorer"
        description="Every intent the protocol has processed. Recipient addresses are truncated — the data is public on-chain either way."
      />

      <PriceTicker symbols={["XRP", "FLR", "BTC", "ETH", "USDC"]} />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="All-time volume"
          value={stats ? formatUsd(stats.totalVolumeUsd) : "—"}
          sublabel={stats ? `${Number(stats.totalVolumeXrp).toLocaleString("en-US")} XRP` : undefined}
          accent="flare"
        />
        <StatTile
          label="Intents today"
          value={stats?.intentsToday ?? "—"}
          sublabel={stats ? `${stats.totalIntents} all time` : undefined}
        />
        <StatTile
          label="Avg settlement"
          value={stats && stats.averageSettlementSeconds !== null ? formatDuration(stats.averageSettlementSeconds) : "—"}
          sublabel="deposit to delivery"
          accent="verify"
        />
        <StatTile
          label="Success rate"
          value={stats ? `${stats.successRatePct}%` : "—"}
          sublabel={stats ? `${stats.failedIntents} failed` : undefined}
          accent="mint"
        />
      </div>

      <FeedHealth />

      <Section
        title="Recent intents"
        description="Updates live as the relayer settles"
        actions={
          <Tabs<Filter>
            active={filter}
            onChange={setFilter}
            tabs={[
              {id: "all", label: "All"},
              {id: "active", label: "In flight"},
              {id: "settled", label: "Settled"},
            ]}
          />
        }
      >
        {error ? (
          <BackendOffline message={error} />
        ) : loading && !data ? (
          <div className="card h-64 animate-pulse" />
        ) : (
          <IntentTable
            intents={data?.intents ?? []}
            anonymise
            emptyTitle="Nothing here yet"
            emptyDescription="Intents appear here within seconds of being created on Flare."
          />
        )}
      </Section>
    </div>
  );
}

/**
 * A live view of the FTSO feeds the protocol depends on.
 *
 * Included on the explorer because feed age is genuinely operational: `PriceOracle` reverts on
 * anything older than 300 seconds, which means a stale feed does not mis-price swaps — it stops
 * them. Seeing the age makes that failure mode legible rather than mysterious.
 */
function FeedHealth() {
  const {prices} = usePrices();
  if (prices.length === 0) return null;

  return (
    <Section title="Oracle feeds" description="Sourced live from FTSOv2 — the same values the settler reads">
      <div className="card overflow-x-auto">
        <table className="w-full min-w-[34rem] text-left text-sm">
          <thead>
            <tr className="border-b border-white/5">
              <th scope="col" className="label px-4 py-3 font-medium">
                Feed
              </th>
              <th scope="col" className="label px-4 py-3 font-medium">
                Price
              </th>
              <th scope="col" className="label px-4 py-3 font-medium">
                Feed id
              </th>
              <th scope="col" className="label px-4 py-3 text-right font-medium">
                Age
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {prices.map((price) => (
              <FeedRow key={price.symbol} price={price} />
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

function FeedRow({price}: {price: PriceSnapshot}) {
  const ageSeconds = Math.max(0, Math.floor(Date.now() / 1000) - price.timestamp);
  // 300s is PriceOracle.maxPriceAge — past it, settlement reverts rather than mis-prices.
  const stale = ageSeconds > 300;

  return (
    <tr>
      <td className="px-4 py-3 font-medium text-slate-200">{price.symbol}/USD</td>
      <td className="tabular px-4 py-3 text-slate-100">${formatPrice(price.price)}</td>
      <td className="mono px-4 py-3 text-[11px] text-slate-600">
        {price.feedId.slice(0, 12)}…{price.feedId.slice(-4)}
      </td>
      <td className={`px-4 py-3 text-right text-xs ${stale ? "text-flare-300" : "text-mint-400"}`}>
        {ageSeconds}s{stale ? " · stale" : ""}
      </td>
    </tr>
  );
}
