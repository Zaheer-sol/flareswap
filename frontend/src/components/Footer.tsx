"use client";

import Link from "next/link";
import {DEFAULT_CHAIN_ID, LINKS, chainInfo, explorerAddressUrl} from "@/lib/constants";
import {useAppConfig} from "@/lib/hooks";
import {shortAddress} from "@/lib/format";

export function Footer() {
  const {data: config} = useAppConfig();
  const chain = chainInfo(DEFAULT_CHAIN_ID);

  const contracts = config
    ? ([
        ["IntentManager", config.contracts.intentManager],
        ["IntentSettler", config.contracts.intentSettler],
        ["PriceOracle", config.contracts.priceOracle],
        ["Minter", config.contracts.minter],
      ] as const)
    : [];

  return (
    <footer className="mt-20 border-t border-white/5 bg-ink-950/60 pb-16 md:pb-0">
      <div className="mx-auto grid max-w-7xl gap-8 px-4 py-10 sm:px-6 md:grid-cols-4">
        <div className="md:col-span-2">
          <p className="text-sm font-bold text-white">
            Flare<span className="text-flare-400">Swap</span>
          </p>
          <p className="mt-2 max-w-sm text-xs leading-relaxed text-slate-500">
            Intent-based cross-chain swaps. Deposit XRP on the XRP Ledger, receive the token you
            asked for on Flare, verified by the Flare Data Connector, priced by FTSOv2, bridged
            by FAssets.
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <span className="chip">Track 1 · Interoperable Asset Products</span>
            <span className="chip">{chain.name}</span>
          </div>
        </div>

        <div>
          <p className="label mb-3">Product</p>
          <ul className="space-y-2 text-xs text-slate-400">
            <li>
              <Link href="/swap" className="hover:text-slate-200">
                Swap
              </Link>
            </li>
            <li>
              <Link href="/pool" className="hover:text-slate-200">
                Liquidity pool
              </Link>
            </li>
            <li>
              <Link href="/explorer" className="hover:text-slate-200">
                Explorer
              </Link>
            </li>
            <li>
              <Link href="/docs" className="hover:text-slate-200">
                How it works
              </Link>
            </li>
          </ul>
        </div>

        <div>
          <p className="label mb-3">Deployed contracts</p>
          {contracts.length > 0 ? (
            <ul className="space-y-2 text-xs">
              {contracts.map(([name, address]) => (
                <li key={name} className="flex items-center justify-between gap-2">
                  <span className="text-slate-500">{name}</span>
                  <a
                    href={explorerAddressUrl(DEFAULT_CHAIN_ID, address) ?? "#"}
                    target="_blank"
                    rel="noreferrer"
                    className="mono text-flare-300 hover:text-flare-200"
                  >
                    {shortAddress(address)}
                  </a>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-slate-600">Not deployed yet.</p>
          )}

          <div className="mt-4 flex flex-wrap gap-3 text-xs">
            <a href={LINKS.github} target="_blank" rel="noreferrer" className="text-slate-400 hover:text-slate-200">
              GitHub ↗
            </a>
            <a
              href={LINKS.flareDevHub}
              target="_blank"
              rel="noreferrer"
              className="text-slate-400 hover:text-slate-200"
            >
              Flare Dev Hub ↗
            </a>
            <a
              href={LINKS.hackathon}
              target="_blank"
              rel="noreferrer"
              className="text-slate-400 hover:text-slate-200"
            >
              Hackathon ↗
            </a>
          </div>
        </div>
      </div>

      <div className="border-t border-white/5 px-4 py-4 sm:px-6">
        <p className="mx-auto max-w-7xl text-[11px] text-slate-600">
          Testnet software, unaudited. Built for the Flare Summer Signal Hackathon.
        </p>
      </div>
    </footer>
  );
}
