"use client";

import {useEffect, useMemo, useState} from "react";
import Link from "next/link";
import {formatUnits} from "ethers";
import {api} from "@/lib/api";
import {useAppConfig, useAsync, useLiveMessages, usePrices} from "@/lib/hooks";
import {useWallet} from "@/lib/wallet";
import {IntentTable} from "@/components/IntentTable";
import {BackendOffline, EmptyState, PageHeader, Section, StatTile, Tabs} from "@/components/ui";
import {erc20Read} from "@/lib/contracts";
import {formatAmount, formatUsd} from "@/lib/format";
import type {AppConfig, IntentRecord, IntentStatus} from "@/lib/types";

type Filter = "all" | "active" | "settled" | "closed";

const FILTER_STATUSES: Record<Filter, IntentStatus[] | undefined> = {
  all: undefined,
  active: ["PENDING", "DEPOSITED", "ATTESTATION_REQUESTED", "ATTESTATION_READY", "SETTLING", "FAILED"],
  settled: ["SETTLED"],
  closed: ["EXPIRED", "CANCELLED"],
};

export default function DashboardPage() {
  const wallet = useWallet();
  const {data: config, error: configError} = useAppConfig();
  const [filter, setFilter] = useState<Filter>("all");
  const [liveBump, setLiveBump] = useState(0);

  const {data, error, loading, reload} = useAsync(
    () =>
      wallet.address
        ? api.intents({user: wallet.address, status: FILTER_STATUSES[filter], limit: 100})
        : Promise.resolve({intents: [], total: 0}),
    [wallet.address, filter, liveBump],
    {enabled: Boolean(wallet.address)},
  );

  // Refresh the list when any of this user's intents changes underneath us.
  useLiveMessages((message) => {
    if (message.type !== "intent") return;
    if (!wallet.address) return;
    if (message.data.userAddress.toLowerCase() === wallet.address.toLowerCase()) {
      setLiveBump((value) => value + 1);
    }
  });

  if (configError) return <BackendOffline message={configError} />;

  if (!wallet.address) {
    return (
      <div className="mx-auto max-w-2xl">
        <PageHeader title="Dashboard" description="Your intents and Flare-side balances." />
        <EmptyState
          icon="⬡"
          title="Connect your wallet"
          description="Your intent history and portfolio are keyed to your Flare address."
          action={
            <button type="button" onClick={() => void wallet.connect()} className="btn-primary">
              Connect wallet
            </button>
          }
        />
      </div>
    );
  }

  const intents = data?.intents ?? [];
  const counts = countByFilter(intents);

  return (
    <div className="space-y-8">
      <PageHeader
        title="Dashboard"
        description="Everything you have swapped, and what it is worth right now."
        actions={
          <Link href="/swap" className="btn-primary">
            New swap
          </Link>
        }
      />

      {config ? <Portfolio config={config} address={wallet.address} /> : null}

      <Section
        title="Intent history"
        description={`${data?.total ?? 0} intent${data?.total === 1 ? "" : "s"} for this wallet`}
        actions={
          <Tabs<Filter>
            active={filter}
            onChange={setFilter}
            tabs={[
              {id: "all", label: "All"},
              {id: "active", label: "Active", count: counts.active},
              {id: "settled", label: "Settled", count: counts.settled},
              {id: "closed", label: "Closed", count: counts.closed},
            ]}
          />
        }
      >
        {loading && intents.length === 0 ? (
          <div className="card h-48 animate-pulse" />
        ) : error ? (
          <BackendOffline message={error} />
        ) : (
          <IntentTable
            intents={intents}
            emptyTitle={filter === "all" ? "No intents yet" : "Nothing here"}
            emptyDescription={
              filter === "all"
                ? "Create your first intent and it will show up here the moment it lands on-chain."
                : "Try a different filter."
            }
            emptyAction={
              filter === "all" ? (
                <Link href="/swap" className="btn-primary">
                  Create an intent
                </Link>
              ) : undefined
            }
          />
        )}

        {intents.length > 0 ? (
          <button type="button" onClick={reload} className="btn-ghost mt-3 text-xs">
            Refresh
          </button>
        ) : null}
      </Section>
    </div>
  );
}

function countByFilter(intents: IntentRecord[]): Record<Filter, number> {
  const inFilter = (filter: Filter, status: IntentStatus): boolean =>
    FILTER_STATUSES[filter]?.includes(status) ?? true;

  return {
    all: intents.length,
    active: intents.filter((intent) => inFilter("active", intent.status)).length,
    settled: intents.filter((intent) => inFilter("settled", intent.status)).length,
    closed: intents.filter((intent) => inFilter("closed", intent.status)).length,
  };
}

/* -------------------------------------------------------------------------- */

interface Balance {
  symbol: string;
  decimals: number;
  raw: bigint;
  usd: number;
}

/**
 * Flare-side balances, valued through FTSO.
 *
 * Balances are read directly from the chain rather than through the backend: they are the one
 * thing the user can verify independently, and going through an API would add a trust hop for
 * no benefit.
 */
function Portfolio({config, address}: {config: AppConfig; address: string}) {
  const {bySymbol} = usePrices();
  const [balances, setBalances] = useState<Balance[] | null>(null);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const tokens = config.tokens;
      const results = await Promise.all(
        tokens.map(async (token) => {
          try {
            const raw: bigint = await erc20Read(token.address, config).balanceOf(address);
            return {symbol: token.symbol, decimals: token.decimals, raw, usd: 0};
          } catch {
            return {symbol: token.symbol, decimals: token.decimals, raw: 0n, usd: 0};
          }
        }),
      );
      if (!cancelled) setBalances(results);
    })();

    return () => {
      cancelled = true;
    };
  }, [config, address]);

  const priced = useMemo<Balance[]>(() => {
    if (!balances) return [];
    return balances.map((balance) => {
      // FXRP tracks XRP one-for-one, so it is priced off the XRP feed.
      const feedSymbol = balance.symbol === "FXRP" ? "XRP" : balance.symbol;
      const price = Number(bySymbol[feedSymbol]?.price ?? 0);
      return {...balance, usd: Number(formatUnits(balance.raw, balance.decimals)) * price};
    });
  }, [balances, bySymbol]);

  const total = priced.reduce((sum, balance) => sum + balance.usd, 0);

  return (
    <Section title="Portfolio" description="Flare-side balances, valued by FTSOv2">
      <div className="grid gap-4 sm:grid-cols-3">
        <StatTile label="Total value" value={formatUsd(total)} accent="flare" sublabel="via FTSOv2" />
        {priced.map((balance) => (
          <StatTile
            key={balance.symbol}
            label={balance.symbol}
            value={formatAmount(balance.raw, balance.decimals, 4)}
            sublabel={formatUsd(balance.usd)}
          />
        ))}
        {balances === null
          ? [0, 1].map((index) => <div key={index} className="card h-[5.5rem] animate-pulse" />)
          : null}
      </div>
    </Section>
  );
}
