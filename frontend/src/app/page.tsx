"use client";

import Link from "next/link";
import {useEffect, useState} from "react";
import {useRouter} from "next/navigation";
import {PriceTicker} from "@/components/PriceTicker";
import {StatTile} from "@/components/ui";
import {useStats} from "@/lib/hooks";
import {formatUsd, formatDuration} from "@/lib/format";
import {LINKS} from "@/lib/constants";
import {STORAGE_KEY, useWallet} from "@/lib/wallet";

export default function LandingPage() {
  const router = useRouter();
  const {address} = useWallet();
  const stats = useStats();

  // A returning user with a wallet already linked doesn't need the pitch again
  // — send them straight to the swap screen. `hasLinkedWallet` gates the
  // loading state so a first-time visitor (nothing in storage) sees the
  // landing page immediately, with no flash either way.
  const [hasLinkedWallet] = useState(
    () => typeof window !== "undefined" && localStorage.getItem(STORAGE_KEY) === "1",
  );
  useEffect(() => {
    if (address) router.replace("/swap");
  }, [address, router]);

  if (hasLinkedWallet && !address) {
    return (
      <div className="flex min-h-[70vh] items-center justify-center">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-flare-400" aria-hidden />
      </div>
    );
  }

  return (
    <div className="space-y-16">
      {/* ------------------------------- hero ------------------------------- */}
      <section className="pt-6 sm:pt-12">
        <div className="mx-auto max-w-3xl text-center">
          <span className="chip mx-auto border-flare-500/30 bg-flare-500/10 text-flare-200">
            Track 1 · Interoperable Asset Products
          </span>

          <h1 className="mt-6 text-4xl font-bold leading-[1.1] tracking-tight text-white sm:text-6xl">
            Swap across chains
            <br />
            with <span className="text-flare-400">one intent</span>
          </h1>

          <p className="mx-auto mt-5 max-w-xl text-base leading-relaxed text-slate-400">
            Tell FlareSwap what you want, like &ldquo;500 XRP for USDC&rdquo;. Send one payment on the
            XRP Ledger. The Flare Data Connector proves it, FTSOv2 prices it, FAssets mints it,
            and the output lands in your Flare wallet.
          </p>

          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <Link href="/swap" className="btn-primary !px-6 !py-3 text-base">
              Start swapping
            </Link>
            <Link href="/docs" className="btn-secondary !px-6 !py-3 text-base">
              How it works
            </Link>
          </div>
        </div>

        <div className="mx-auto mt-12 max-w-4xl">
          <PriceTicker />
        </div>
      </section>

      {/* ---------------------------- the problem --------------------------- */}
      <section className="mx-auto max-w-5xl">
        <div className="card overflow-hidden">
          <div className="grid md:grid-cols-2">
            <div className="border-b border-white/5 p-6 md:border-b-0 md:border-r sm:p-8">
              <p className="label text-slate-600">Today</p>
              <p className="mt-2 text-lg font-semibold text-slate-300">Five steps, three interfaces</p>
              <ol className="mt-4 space-y-2.5 text-sm text-slate-500">
                {[
                  "Find a bridge you trust",
                  "Wrap XRP into FXRP manually",
                  "Navigate to a DEX on Flare",
                  "Swap FXRP for USDC",
                  "Hold gas tokens on both chains",
                ].map((step, index) => (
                  <li key={step} className="flex gap-3">
                    <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-white/10 text-[11px] text-slate-600">
                      {index + 1}
                    </span>
                    {step}
                  </li>
                ))}
              </ol>
              <p className="mt-5 text-xs text-slate-600">
                Price slippage between every step. Most users give up.
              </p>
            </div>

            <div className="bg-flare-500/[0.04] p-6 sm:p-8">
              <p className="label text-flare-400">With FlareSwap</p>
              <p className="mt-2 text-lg font-semibold text-white">One intent, one payment</p>
              <ol className="mt-4 space-y-3 text-sm text-slate-300">
                {[
                  {title: "Express your intent", body: "Sign one transaction on Flare committing to your terms."},
                  {title: "Deposit on the source chain", body: "One XRPL payment, with the intent id as the memo."},
                  {title: "Receive on Flare", body: "The output token arrives in your wallet."},
                ].map((step, index) => (
                  <li key={step.title} className="flex gap-3">
                    <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-flare-500/20 text-[11px] font-bold text-flare-300">
                      {index + 1}
                    </span>
                    <span>
                      <span className="font-medium text-white">{step.title}</span>
                      <span className="mt-0.5 block text-xs text-slate-500">{step.body}</span>
                    </span>
                  </li>
                ))}
              </ol>
              <p className="mt-5 text-xs text-slate-500">
                Terms are committed on-chain before you pay, so nobody can settle you on worse ones.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ------------------------- Flare integration ------------------------ */}
      <section className="mx-auto max-w-5xl">
        <div className="mb-6 text-center">
          <h2 className="text-2xl font-bold text-white">Built on three Flare protocols</h2>
          <p className="mt-2 text-sm text-slate-500">
            Not one integration bolted on. Each protocol does the job only it can do.
          </p>
        </div>

        <div className="grid gap-4 md:grid-cols-3">
          {[
            {
              name: "FDC",
              full: "Flare Data Connector",
              role: "Proves the XRPL deposit really happened",
              detail:
                "Flare's validators independently attest to the payment. The settler verifies a Merkle proof on-chain (no centralised oracle, no trusted relayer).",
              href: LINKS.fdcDocs,
            },
            {
              name: "FTSOv2",
              full: "Time Series Oracle",
              role: "Prices every quote and bounds every fill",
              detail:
                "Block-latency XRP/USD and USDC/USD feeds. The settler refuses any fill more than your slippage tolerance below oracle fair value.",
              href: LINKS.ftsoDocs,
            },
            {
              name: "FAssets",
              full: "FXRP minting",
              role: "Turns proven XRP into an ERC-20 on Flare",
              detail:
                "The attested payment drives a real collateral-backed mint, producing FXRP that trades against USDC in the pool.",
              href: LINKS.fassetsDocs,
            },
          ].map((protocol) => (
            <a
              key={protocol.name}
              href={protocol.href}
              target="_blank"
              rel="noreferrer"
              className="card card-hover group p-5"
            >
              <div className="flex items-baseline justify-between">
                <span className="text-lg font-bold text-flare-400">{protocol.name}</span>
                <span className="text-[10px] uppercase tracking-wider text-slate-600 transition-colors group-hover:text-slate-400">
                  docs ↗
                </span>
              </div>
              <p className="mt-0.5 text-[11px] uppercase tracking-wider text-slate-600">{protocol.full}</p>
              <p className="mt-3 text-sm font-medium text-slate-200">{protocol.role}</p>
              <p className="mt-2 text-xs leading-relaxed text-slate-500">{protocol.detail}</p>
            </a>
          ))}
        </div>
      </section>

      {/* ------------------------------- stats ------------------------------ */}
      <section className="mx-auto max-w-5xl">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatTile
            label="Total volume"
            value={stats ? formatUsd(stats.totalVolumeUsd) : "-"}
            sublabel={stats ? `${Number(stats.totalVolumeXrp).toLocaleString("en-US")} XRP settled` : undefined}
            accent="flare"
          />
          <StatTile label="Intents created" value={stats?.totalIntents ?? "-"} sublabel={stats ? `${stats.intentsToday} today` : undefined} />
          <StatTile
            label="Avg settlement"
            value={stats?.averageSettlementSeconds !== null && stats ? formatDuration(stats.averageSettlementSeconds) : "-"}
            sublabel="deposit to delivery"
            accent="verify"
          />
          <StatTile
            label="Success rate"
            value={stats ? `${stats.successRatePct}%` : "-"}
            sublabel={stats ? `${stats.settledIntents} settled` : undefined}
            accent="mint"
          />
        </div>
      </section>

      {/* ----------------------------- supported ---------------------------- */}
      <section className="mx-auto max-w-5xl">
        <div className="card p-6 sm:p-8">
          <p className="label">Supported assets</p>
          <div className="mt-4 flex flex-wrap gap-3">
            {[
              {symbol: "XRP", role: "source", live: true},
              {symbol: "FXRP", role: "destination", live: true},
              {symbol: "USDC", role: "destination", live: true},
              {symbol: "BTC", role: "source", live: false},
              {symbol: "FLR", role: "destination", live: false},
            ].map((asset) => (
              <span
                key={asset.symbol}
                className={`chip ${asset.live ? "border-white/10" : "border-white/5 text-slate-600"}`}
              >
                <span
                  className={`h-1.5 w-1.5 rounded-full ${asset.live ? "bg-mint-400" : "bg-slate-700"}`}
                />
                {asset.symbol}
                <span className="text-slate-600">· {asset.live ? asset.role : "soon"}</span>
              </span>
            ))}
          </div>
        </div>
      </section>

      {/* -------------------------------- CTA ------------------------------- */}
      <section className="mx-auto max-w-3xl pb-6 text-center">
        <h2 className="text-2xl font-bold text-white">Ready to try it?</h2>
        <p className="mt-2 text-sm text-slate-500">
          Running on Coston2 testnet. Grab test tokens from the faucet and swap in under a minute.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-3">
          <Link href="/swap" className="btn-primary !px-6 !py-3">
            Create an intent
          </Link>
          <a
            href="https://faucet.flare.network/coston2"
            target="_blank"
            rel="noreferrer"
            className="btn-secondary !px-6 !py-3"
          >
            Coston2 faucet ↗
          </a>
        </div>
      </section>
    </div>
  );
}
