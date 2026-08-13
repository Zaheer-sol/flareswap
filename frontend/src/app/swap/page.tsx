"use client";

import {useEffect, useMemo, useState} from "react";
import Link from "next/link";
import {api} from "@/lib/api";
import {useAppConfig, useDebounced, usePrice} from "@/lib/hooks";
import {useWallet} from "@/lib/wallet";
import {useToast} from "@/components/Toast";
import {DepositInstructions} from "@/components/DepositInstructions";
import {BackendOffline, PageHeader, Spinner, VerifiedByFlare} from "@/components/ui";
import {intentManagerWrite, describeContractError} from "@/lib/contracts";
import {
  DEADLINE_OPTIONS,
  DEFAULT_CHAIN_ID,
  DEFAULT_DEADLINE_SECONDS,
  DEFAULT_SLIPPAGE_BPS,
  SLIPPAGE_PRESETS,
  chainInfo,
  explorerTxUrl,
} from "@/lib/constants";
import {formatAmount, formatBps, formatPrice, xrpToDrops} from "@/lib/format";
import type {AppConfig, DepositInstructions as Instructions, QuoteResult, TokenInfo} from "@/lib/types";

/**
 * How far below the live oracle floor we set the intent's *absolute* `minOutputAmount`.
 *
 * Two different protections are at work, and conflating them is the classic way to strand a
 * user's deposit:
 *
 *   * `maxSlippageBps` is checked against FTSO **at settlement time**, so it tracks the market
 *     and is the meaningful "am I getting a fair price" guarantee.
 *   * `minOutputAmount` is an **absolute** number fixed when the intent is created. If we set it
 *     to the quote-time floor and XRP then moves 4% before the deposit is attested, settlement
 *     reverts forever and the XRP has to be refunded by hand — even though the fill would have
 *     been perfectly fair in relative terms.
 *
 * So the absolute floor is set as a genuine disaster backstop below the relative one, and the
 * relative bound does the precise work. The UI shows both.
 */
const ABSOLUTE_FLOOR_BUFFER_BPS = 500n;

export default function SwapPage() {
  const {data: config, error: configError, reload} = useAppConfig();

  if (configError) return <BackendOffline message={configError} />;
  if (!config) {
    return (
      <div className="mx-auto max-w-lg">
        <div className="card h-[28rem] animate-pulse" />
      </div>
    );
  }

  return <SwapForm config={config} onReloadConfig={reload} />;
}

function SwapForm({config, onReloadConfig}: {config: AppConfig; onReloadConfig: () => void}) {
  const wallet = useWallet();
  const toast = useToast();
  const xrpPrice = usePrice("XRP");

  // Every destination the contracts accept, straight from the deployment. Adding a token is a
  // deploy-script change, never a frontend one.
  const destinations = config.tokens;
  const [destination, setDestination] = useState<TokenInfo>(
    () => destinations.find((token) => !token.isFAsset) ?? destinations[0]!,
  );

  const [amountInput, setAmountInput] = useState("500");
  const [slippageBps, setSlippageBps] = useState<number>(DEFAULT_SLIPPAGE_BPS);
  const [customSlippage, setCustomSlippage] = useState("");
  const [deadlineSeconds, setDeadlineSeconds] = useState<number>(DEFAULT_DEADLINE_SECONDS);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const [quote, setQuote] = useState<QuoteResult | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [quoting, setQuoting] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [created, setCreated] = useState<{intentId: string; instructions: Instructions} | null>(null);

  const amountDrops = xrpToDrops(amountInput);
  const debouncedDrops = useDebounced(amountDrops.toString(), 350);
  const debouncedSlippage = useDebounced(slippageBps, 350);

  /* ------------------------------- quoting -------------------------------- */

  useEffect(() => {
    if (BigInt(debouncedDrops) === 0n) {
      setQuote(null);
      setQuoteError(null);
      return;
    }
    let cancelled = false;
    setQuoting(true);

    void api
      .quote({amountDrops: debouncedDrops, to: destination.address, slippageBps: debouncedSlippage})
      .then((result) => {
        if (!cancelled) {
          setQuote(result);
          setQuoteError(null);
        }
      })
      .catch((error: Error) => {
        if (!cancelled) {
          setQuote(null);
          setQuoteError(error.message);
        }
      })
      .finally(() => {
        if (!cancelled) setQuoting(false);
      });

    return () => {
      cancelled = true;
    };
  }, [debouncedDrops, destination.address, debouncedSlippage]);

  // Re-quote on a slow timer too: FTSO moves and a stale headline rate is misleading.
  useEffect(() => {
    const timer = setInterval(() => {
      if (BigInt(amountDrops) > 0n && !created) {
        void api
          .quote({amountDrops: amountDrops.toString(), to: destination.address, slippageBps})
          .then(setQuote)
          .catch(() => undefined);
      }
    }, 12_000);
    return () => clearInterval(timer);
  }, [amountDrops, destination.address, slippageBps, created]);

  /* ------------------------------ derived UI ------------------------------ */

  const absoluteFloor = useMemo(() => {
    if (!quote) return 0n;
    const amm = BigInt(quote.ammOutput);
    const total = BigInt(slippageBps) + ABSOLUTE_FLOOR_BUFFER_BPS;
    if (total >= 10_000n) return 0n;
    return (amm * (10_000n - total)) / 10_000n;
  }, [quote, slippageBps]);

  const usdValue = xrpPrice ? Number(amountInput || 0) * Number(xrpPrice.price) : null;

  const validationError = useMemo(() => {
    if (!amountInput.trim()) return null;
    if (amountDrops === 0n) return "Enter an amount greater than zero";
    if (amountDrops < 1_000_000n) return "Minimum deposit is 1 XRP";
    return null;
  }, [amountInput, amountDrops]);

  const canSubmit =
    Boolean(wallet.address) &&
    wallet.isCorrectChain &&
    !validationError &&
    Boolean(quote) &&
    !submitting &&
    !created;

  /* ------------------------------- submit --------------------------------- */

  async function createIntent(): Promise<void> {
    if (!quote) return;
    setSubmitting(true);

    const pendingToast = toast.push({
      kind: "pending",
      title: "Confirm in your wallet",
      body: "Committing your intent terms to Flare.",
    });

    try {
      const signer = await wallet.getSigner();
      const manager = intentManagerWrite(config, signer);
      const deadline = BigInt(Math.floor(Date.now() / 1000) + deadlineSeconds);

      // Simulate first so a bad parameter surfaces as a readable error rather than a failed tx.
      await manager.createIntent.staticCall(
        0,
        amountDrops,
        destination.address,
        absoluteFloor,
        deadline,
        slippageBps,
      );

      const tx = await manager.createIntent(
        0,
        amountDrops,
        destination.address,
        absoluteFloor,
        deadline,
        slippageBps,
      );

      toast.update(pendingToast, {
        kind: "pending",
        title: "Creating intent",
        body: "Waiting for confirmation on Flare…",
        href: explorerTxUrl(DEFAULT_CHAIN_ID, tx.hash) ?? undefined,
      });

      const receipt = await tx.wait();
      if (!receipt || receipt.status !== 1) throw new Error("Intent creation reverted");

      const intentId = extractIntentId(receipt, config.contracts.intentManager);
      if (!intentId) throw new Error("Could not read the intent id from the transaction logs");

      toast.update(pendingToast, {
        kind: "success",
        title: "Intent created",
        body: "Now send the XRPL payment shown below.",
        href: explorerTxUrl(DEFAULT_CHAIN_ID, tx.hash) ?? undefined,
      });

      // Ask the backend for the canonical instructions — it derives the memo the same way the
      // relayer and the FDC will read it back.
      const detail = await api.intent(intentId).catch(() => null);
      setCreated({
        intentId,
        instructions: detail?.depositInstructions ?? {
          destination: config.xrpl.depositAddress,
          destinationTag: 0,
          amountDrops: amountDrops.toString(),
          amountXrp: amountInput,
          memoHex: intentId.slice(2).toUpperCase(),
          transaction: {},
        },
      });
    } catch (error) {
      toast.update(pendingToast, {
        kind: "error",
        title: "Could not create intent",
        body: describeContractError(error),
      });
    } finally {
      setSubmitting(false);
    }
  }

  /* -------------------------------- render -------------------------------- */

  if (created) {
    return (
      <div className="mx-auto max-w-2xl space-y-5">
        <PageHeader
          eyebrow="Step 2 of 2"
          title="Send your deposit"
          description="Your terms are locked in on Flare. The relayer settles automatically once the Flare Data Connector attests to this payment."
        />

        <DepositInstructions instructions={created.instructions} network={config.xrpl.network} />

        <div className="flex flex-col gap-3 sm:flex-row">
          <Link href={`/intent/${created.intentId}`} className="btn-primary flex-1 justify-center">
            Track this intent
          </Link>
          <button
            type="button"
            onClick={() => {
              setCreated(null);
              onReloadConfig();
            }}
            className="btn-secondary justify-center"
          >
            New swap
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-lg">
      <PageHeader title="Swap" description="Express what you want. One XRPL payment does the rest." />

      <div className="card p-4 sm:p-6">
        {/* ------------------------------ from ------------------------------ */}
        <div className="rounded-xl border border-white/5 bg-ink-950/50 p-3.5 sm:p-4">
          <div className="flex items-center justify-between gap-2">
            <span className="label">You send</span>
            <span className="chip shrink-0 !py-0.5 text-[11px]">XRP Ledger</span>
          </div>

          {/* min-w-0 on the input is what lets it shrink instead of forcing overflow. */}
          <div className="mt-3 flex items-center gap-2 sm:gap-3">
            <input
              type="text"
              inputMode="decimal"
              value={amountInput}
              onChange={(event) => setAmountInput(event.target.value.replace(/[^\d.]/g, ""))}
              placeholder="0.0"
              aria-label="Amount of XRP to send"
              className="tabular w-full min-w-0 flex-1 bg-transparent text-2xl font-semibold text-white outline-none placeholder:text-slate-700 sm:text-3xl"
            />
            <span className="flex shrink-0 items-center gap-1.5 rounded-xl border border-white/10 bg-white/5 px-2.5 py-2 sm:gap-2 sm:px-3">
              <TokenIcon symbol="XRP" />
              <span className="text-sm font-semibold text-white">XRP</span>
            </span>
          </div>

          <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs">
            <span className="text-slate-500">
              {usdValue !== null
                ? `≈ $${usdValue.toLocaleString("en-US", {maximumFractionDigits: 2})}`
                : "-"}
            </span>
            <div className="flex gap-1">
              {["100", "500", "1000"].map((preset) => (
                <button
                  key={preset}
                  type="button"
                  onClick={() => setAmountInput(preset)}
                  className="rounded-md px-1.5 py-0.5 text-[11px] text-slate-500 hover:bg-white/5 hover:text-slate-300"
                >
                  {preset}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* ----------------------------- arrow ------------------------------ */}
        <div className="relative -my-2 flex justify-center" aria-hidden>
          <span className="flex h-8 w-8 items-center justify-center rounded-lg border border-white/10 bg-ink-850 text-slate-500">
            ↓
          </span>
        </div>

        {/* ------------------------------- to ------------------------------- */}
        <div className="rounded-xl border border-white/5 bg-ink-950/50 p-3.5 sm:p-4">
          <div className="flex items-center justify-between gap-2">
            <span className="label">You receive</span>
            <span className="chip shrink-0 !py-0.5 text-[11px]">Flare</span>
          </div>

          <div className="mt-3 flex items-center gap-2 sm:gap-3">
            <span className="tabular min-w-0 flex-1 truncate text-2xl font-semibold text-white sm:text-3xl">
              {quoting && !quote ? (
                <span className="skeleton inline-block h-7 w-28 align-middle sm:h-8 sm:w-32" />
              ) : quote ? (
                formatAmount(quote.ammOutput, destination.decimals, 4)
              ) : (
                <span className="text-slate-700">0.0</span>
              )}
            </span>

            <TokenSelect tokens={destinations} value={destination} onChange={setDestination} />
          </div>

          <p className="mt-2 truncate text-xs text-slate-500">
            To {wallet.address ? shortenAddress(wallet.address) : "your connected wallet"}
            {destination.isFAsset ? " · delivered directly, no swap" : null}
          </p>
        </div>

        {/* ----------------------------- quote ------------------------------ */}
        {quote ? (
          <QuotePanel
            quote={quote}
            destination={destination}
            absoluteFloor={absoluteFloor}
            slippageBps={slippageBps}
            stale={quoting}
          />
        ) : quoteError ? (
          <p className="mt-4 rounded-xl border border-flare-700/40 bg-flare-900/10 px-3.5 py-3 text-xs text-flare-200">
            {quoteError.includes("no deployment")
              ? "Contracts are not deployed on this network yet."
              : `Could not fetch a quote: ${quoteError}`}
          </p>
        ) : null}

        {/* ---------------------------- settings ---------------------------- */}
        <div className="mt-4">
          <button
            type="button"
            onClick={() => setShowAdvanced((open) => !open)}
            aria-expanded={showAdvanced}
            className="flex w-full items-center justify-between gap-2 rounded-lg px-1 py-1.5 text-xs font-medium text-slate-500 hover:text-slate-300"
          >
            <span className="truncate">
              Slippage {formatBps(slippageBps)} · deadline{" "}
              {DEADLINE_OPTIONS.find((option) => option.seconds === deadlineSeconds)?.label ?? "custom"}
            </span>
            <span aria-hidden className="shrink-0">
              {showAdvanced ? "−" : "+"}
            </span>
          </button>

          {showAdvanced ? (
            <div className="mt-2 space-y-4 rounded-xl border border-white/5 bg-ink-950/50 p-3.5 sm:p-4">
              <div>
                <p className="label mb-2">Max slippage vs FTSO</p>
                <div className="flex flex-wrap gap-2">
                  {SLIPPAGE_PRESETS.map((preset) => (
                    <button
                      key={preset}
                      type="button"
                      onClick={() => {
                        setSlippageBps(preset);
                        setCustomSlippage("");
                      }}
                      className={`rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors ${
                        slippageBps === preset && !customSlippage
                          ? "border-flare-500/50 bg-flare-500/15 text-flare-200"
                          : "border-white/10 text-slate-400 hover:border-white/20"
                      }`}
                    >
                      {formatBps(preset)}
                    </button>
                  ))}
                  <div className="flex items-center gap-1 rounded-lg border border-white/10 px-2 py-1.5">
                    <input
                      type="text"
                      inputMode="decimal"
                      value={customSlippage}
                      onChange={(event) => {
                        const raw = event.target.value.replace(/[^\d.]/g, "");
                        setCustomSlippage(raw);
                        const bps = Math.round(Number(raw || 0) * 100);
                        if (bps > 0 && bps <= 5000) setSlippageBps(bps);
                      }}
                      placeholder="Custom"
                      aria-label="Custom slippage percentage"
                      className="tabular w-14 bg-transparent text-xs text-white outline-none placeholder:text-slate-600"
                    />
                    <span className="text-xs text-slate-600">%</span>
                  </div>
                </div>
                <p className="mt-2 text-[11px] leading-relaxed text-slate-600">
                  Checked against the FTSO price <em>at settlement time</em>, not now, so it tracks
                  the market while your deposit is in flight.
                </p>
              </div>

              <div>
                <p className="label mb-2">Deadline</p>
                <div className="flex flex-wrap gap-2">
                  {DEADLINE_OPTIONS.map((option) => (
                    <button
                      key={option.seconds}
                      type="button"
                      onClick={() => setDeadlineSeconds(option.seconds)}
                      className={`rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors ${
                        deadlineSeconds === option.seconds
                          ? "border-flare-500/50 bg-flare-500/15 text-flare-200"
                          : "border-white/10 text-slate-400 hover:border-white/20"
                      }`}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
                <p className="mt-2 text-[11px] text-slate-600">
                  After this, the intent expires and any deposit must be refunded manually.
                </p>
              </div>

              {quote ? (
                <div className="border-t border-white/5 pt-3">
                  <div className="flex items-start justify-between gap-3 text-[11px]">
                    <span className="text-slate-600">Absolute floor written on-chain</span>
                    <span className="tabular shrink-0 text-slate-400">
                      {formatAmount(absoluteFloor, destination.decimals, 4)} {destination.symbol}
                    </span>
                  </div>
                  <p className="mt-1 text-[11px] leading-relaxed text-slate-600">
                    A fixed disaster backstop set {formatBps(Number(ABSOLUTE_FLOOR_BUFFER_BPS))} below
                    your slippage floor, so a normal price move while the deposit is in flight cannot
                    permanently strand it.
                  </p>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>

        {/* ----------------------------- action ----------------------------- */}
        <div className="mt-5">
          {validationError ? (
            <p className="mb-2 text-center text-xs text-flare-300">{validationError}</p>
          ) : null}

          {!wallet.address ? (
            <button
              type="button"
              onClick={() => void wallet.connect()}
              disabled={wallet.connecting}
              className="btn-primary w-full !py-3"
            >
              {wallet.connecting ? "Connecting…" : "Connect wallet"}
            </button>
          ) : !wallet.isCorrectChain ? (
            <button
              type="button"
              onClick={() => void wallet.switchChain()}
              className="btn-primary w-full !py-3"
            >
              Switch to {chainInfo(DEFAULT_CHAIN_ID).name}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void createIntent()}
              disabled={!canSubmit}
              className="btn-primary w-full !py-3"
            >
              {submitting ? (
                <>
                  <Spinner /> Creating intent…
                </>
              ) : (
                "Create intent"
              )}
            </button>
          )}

          <p className="mt-3 text-center text-[11px] leading-relaxed text-slate-600">
            Creating an intent costs one Flare transaction. You send the XRP afterwards. Nothing
            leaves your XRPL wallet until you sign that payment yourself.
          </p>
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

/**
 * Destination picker.
 *
 * A native `<select>` rather than a custom popover: it gets the platform's own picker on mobile
 * (a scroll wheel rather than a cramped dropdown), keyboard and screen-reader behaviour for free,
 * and cannot overflow a narrow viewport. The trade-off is limited styling of the option list,
 * which is not worth re-implementing correctly for a handful of tokens.
 */
function TokenSelect({
  tokens,
  value,
  onChange,
}: {
  tokens: TokenInfo[];
  value: TokenInfo;
  onChange: (token: TokenInfo) => void;
}) {
  return (
    <label className="relative flex shrink-0 items-center gap-1.5 rounded-xl border border-white/10 bg-white/5 py-2 pl-2.5 pr-7 transition-colors hover:border-white/20 sm:gap-2 sm:pl-3 sm:pr-8">
      <span className="sr-only">Destination token</span>
      <TokenIcon symbol={value.symbol} />
      <span className="text-sm font-semibold text-white">{value.symbol}</span>
      <span aria-hidden className="pointer-events-none absolute right-2.5 text-[10px] text-slate-500">
        ▼
      </span>
      <select
        value={value.address}
        onChange={(event) => {
          const next = tokens.find((token) => token.address === event.target.value);
          if (next) onChange(next);
        }}
        className="absolute inset-0 cursor-pointer opacity-0"
      >
        {tokens.map((token) => (
          <option key={token.address} value={token.address}>
            {token.symbol}
          </option>
        ))}
      </select>
    </label>
  );
}

function QuotePanel({
  quote,
  destination,
  absoluteFloor,
  slippageBps,
  stale,
}: {
  quote: QuoteResult;
  destination: TokenInfo;
  absoluteFloor: bigint;
  slippageBps: number;
  stale: boolean;
}) {
  const impactHigh = quote.priceImpactBps > 100;
  const minimum =
    BigInt(quote.minimumOutput) > absoluteFloor ? quote.minimumOutput : absoluteFloor.toString();

  return (
    <div
      className={`mt-4 space-y-2 rounded-xl border border-white/5 bg-ink-950/40 p-3.5 transition-opacity sm:p-4 ${
        stale ? "opacity-60" : ""
      }`}
    >
      <Row label="Rate">
        <VerifiedByFlare protocol="FTSO">
          <span className="tabular">
            1 XRP = {formatPrice(quote.rate)} {destination.symbol}
          </span>
        </VerifiedByFlare>
      </Row>

      <Row label="Oracle fair value" hint="What FTSO says the output is worth, before AMM curve">
        <span className="tabular">
          {formatAmount(quote.expectedOutput, destination.decimals, 4)} {destination.symbol}
        </span>
      </Row>

      {!destination.isFAsset ? (
        <Row label="Price impact" hint="How far this trade moves the pool">
          <span className={`tabular ${impactHigh ? "text-flare-300" : "text-slate-300"}`}>
            {formatBps(quote.priceImpactBps)}
          </span>
        </Row>
      ) : null}

      <Row label="Protocol fee" hint="0.30% of the minted FXRP">
        <span className="tabular">{formatAmount(quote.protocolFee, 6, 4)} FXRP</span>
      </Row>

      <div className="border-t border-white/5 pt-2">
        <Row label={`Minimum received (${formatBps(slippageBps)})`}>
          <span className="tabular font-semibold text-white">
            {formatAmount(minimum, destination.decimals, 4)} {destination.symbol}
          </span>
        </Row>
      </div>

      {impactHigh ? (
        <p className="rounded-lg border border-flare-700/40 bg-flare-900/20 px-2.5 py-2 text-[11px] leading-relaxed text-flare-200">
          High price impact: this trade is large relative to the {destination.symbol} pool.
          Consider splitting it or choosing a deeper pair.
        </p>
      ) : null}
    </div>
  );
}

/** Label left, value right, both allowed to wrap rather than overflow on narrow screens. */
function Row({label, hint, children}: {label: string; hint?: string; children: React.ReactNode}) {
  return (
    <div className="flex items-start justify-between gap-3 text-xs">
      <span className="min-w-0 text-slate-500" title={hint}>
        {label}
      </span>
      <span className="min-w-0 shrink-0 text-right text-slate-300">{children}</span>
    </div>
  );
}

function TokenIcon({symbol}: {symbol: string}) {
  return (
    <span
      className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-slate-600 to-slate-800 text-[9px] font-bold text-white"
      aria-hidden
    >
      {symbol.slice(0, 2)}
    </span>
  );
}

function shortenAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/**
 * Pulls the intent id out of the `IntentCreated` log.
 *
 * Read from the receipt rather than from a follow-up `getUserIntents` call: the id is the first
 * indexed topic, so it is available the moment the transaction confirms, with no extra RPC
 * round-trip and no race against the indexer.
 */
function extractIntentId(
  receipt: {logs: readonly {address: string; topics: readonly string[]}[]},
  managerAddress: string,
): string | null {
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== managerAddress.toLowerCase()) continue;
    if (log.topics.length < 2) continue;
    return log.topics[1]!;
  }
  return null;
}
