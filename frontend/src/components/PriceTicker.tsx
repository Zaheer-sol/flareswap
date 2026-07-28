"use client";

import {usePrices} from "@/lib/hooks";
import {formatPrice} from "@/lib/format";

/**
 * Live FTSOv2 prices, straight through from the oracle.
 *
 * Kept on the landing page deliberately: it is the most immediate demonstration that FTSO is
 * wired up, and the ~1.8s block-latency updates are visible to the naked eye.
 */
export function PriceTicker({symbols = ["XRP", "FLR", "BTC", "USDC"]}: {symbols?: string[]}) {
  const {bySymbol} = usePrices();
  const hasAny = symbols.some((symbol) => bySymbol[symbol]);

  return (
    <div className="card flex flex-wrap items-center gap-x-6 gap-y-3 px-5 py-3.5">
      <span className="label flex items-center gap-1.5">
        <span className="relative flex h-1.5 w-1.5">
          <span
            className={`absolute inline-flex h-full w-full rounded-full ${
              hasAny ? "animate-pulse-ring bg-verify-400" : "bg-slate-700"
            }`}
          />
          <span
            className={`relative inline-flex h-1.5 w-1.5 rounded-full ${
              hasAny ? "bg-verify-400" : "bg-slate-700"
            }`}
          />
        </span>
        FTSOv2
      </span>

      {symbols.map((symbol) => {
        const snapshot = bySymbol[symbol];
        return (
          <div key={symbol} className="flex items-baseline gap-2">
            <span className="text-xs font-medium text-slate-500">{symbol}/USD</span>
            {snapshot ? (
              <span className="tabular text-sm font-semibold text-slate-100">
                ${formatPrice(snapshot.price)}
              </span>
            ) : (
              <span className="skeleton inline-block h-4 w-14" />
            )}
          </div>
        );
      })}

      {!hasAny ? (
        <span className="text-[11px] text-slate-600">waiting for the price API…</span>
      ) : (
        <span className="ml-auto hidden text-[11px] text-slate-600 sm:block">
          block-latency feeds, ~1.8s
        </span>
      )}
    </div>
  );
}
