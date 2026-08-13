"use client";

import {useEffect, useMemo, useState} from "react";
import {formatUnits} from "ethers";
import {api} from "@/lib/api";
import {useAppConfig, useAsync} from "@/lib/hooks";
import {useWallet} from "@/lib/wallet";
import {useToast} from "@/components/Toast";
import {
  BackendOffline,
  DetailRow,
  PageHeader,
  Section,
  Spinner,
  StatTile,
  Tabs,
} from "@/components/ui";
import {erc20Read, erc20Write, liquidityPoolRead, liquidityPoolWrite, describeContractError} from "@/lib/contracts";
import {formatAmount, formatBps, formatUsd, parseAmount} from "@/lib/format";
import {DEFAULT_CHAIN_ID, chainInfo, explorerAddressUrl, explorerTxUrl} from "@/lib/constants";
import type {AppConfig, PoolStats} from "@/lib/types";

type Mode = "add" | "remove";

export default function PoolPage() {
  const {data: config, error: configError} = useAppConfig();
  const {data: pools, error: poolError, reload} = useAsync(() => api.pools(), [], {pollMs: 10_000});
  const [selected, setSelected] = useState(0);

  if (configError || poolError) return <BackendOffline message={configError ?? poolError ?? undefined} />;
  if (!config || !pools || pools.length === 0) {
    return (
      <div className="space-y-6">
        <PageHeader title="Liquidity pool" />
        <div className="grid gap-4 sm:grid-cols-4">
          {[0, 1, 2, 3].map((index) => (
            <div key={index} className="card h-[5.5rem] animate-pulse" />
          ))}
        </div>
      </div>
    );
  }

  const pool = pools[Math.min(selected, pools.length - 1)]!;

  return (
    <PoolView
      config={config}
      pool={pool}
      pools={pools}
      selected={selected}
      onSelect={setSelected}
      onChanged={reload}
    />
  );
}

function PoolView({
  config,
  pool,
  pools,
  selected,
  onSelect,
  onChanged,
}: {
  config: AppConfig;
  pool: PoolStats;
  pools: PoolStats[];
  selected: number;
  onSelect: (index: number) => void;
  onChanged: () => void;
}) {
  const ratio =
    BigInt(pool.token0.reserve) > 0n
      ? Number(formatUnits(BigInt(pool.spotPrice0In1), 18))
      : 0;

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow={`${pool.token0.symbol} / ${pool.token1.symbol}`}
        title="Liquidity pools"
        description="A constant-product AMM. Every settled intent routes through it, and LPs earn the swap fee."
        actions={
          <a
            href={explorerAddressUrl(DEFAULT_CHAIN_ID, pool.address) ?? "#"}
            target="_blank"
            rel="noreferrer"
            className="btn-secondary"
          >
            View contract ↗
          </a>
        }
      />

      {pools.length > 1 ? (
        <Tabs<string>
          active={String(selected)}
          onChange={(id) => onSelect(Number(id))}
          tabs={pools.map((entry, index) => ({
            id: String(index),
            label: `FXRP / ${entry.token1.symbol}`,
          }))}
        />
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Total liquidity" value={formatUsd(pool.tvlUsd)} accent="flare" sublabel="valued via FTSOv2" />
        <StatTile
          label={`${pool.token0.symbol} reserve`}
          value={formatAmount(pool.token0.reserve, pool.token0.decimals, 2)}
        />
        <StatTile
          label={`${pool.token1.symbol} reserve`}
          value={formatAmount(pool.token1.reserve, pool.token1.decimals, 2)}
        />
        <StatTile
          label="Pool rate"
          value={`${ratio.toFixed(4)}`}
          sublabel={`${pool.token1.symbol} per ${pool.token0.symbol}`}
          accent="verify"
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr,22rem]">
        <Section title="Pool details">
          <div className="card divide-y divide-white/5 px-4 py-1">
            <DetailRow label="Swap fee" hint="Retained by liquidity providers">
              {formatBps(pool.swapFeeBps)}
            </DetailRow>
            <DetailRow label="Lifetime swaps">
              <span className="tabular">{pool.swapCount.toLocaleString("en-US")}</span>
            </DetailRow>
            <DetailRow label={`Lifetime ${pool.token0.symbol} volume`}>
              <span className="tabular">
                {formatAmount(pool.cumulativeVolume0, pool.token0.decimals, 2)}
              </span>
            </DetailRow>
            <DetailRow label={`Lifetime ${pool.token1.symbol} volume`}>
              <span className="tabular">
                {formatAmount(pool.cumulativeVolume1, pool.token1.decimals, 2)}
              </span>
            </DetailRow>
            <DetailRow label="LP token supply">
              <span className="tabular">{formatAmount(pool.totalSupply, 18, 4)}</span>
            </DetailRow>
          </div>

          <div className="card mt-4 p-4">
            <p className="text-xs font-semibold text-slate-300">Why the pool matters for settlement</p>
            <p className="mt-1.5 text-xs leading-relaxed text-slate-500">
              <span className="text-slate-400">IntentSettler</span> refuses any fill more than the
              user&rsquo;s slippage tolerance below the FTSO fair value. A thin or skewed pool
              therefore does not produce bad fills. It produces reverted settlements. Deep,
              on-market liquidity is what keeps the success rate high.
            </p>
          </div>
        </Section>

        <div>
          <LiquidityPanel config={config} pool={pool} onChanged={onChanged} />
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function LiquidityPanel({
  config,
  pool,
  onChanged,
}: {
  config: AppConfig;
  pool: PoolStats;
  onChanged: () => void;
}) {
  const wallet = useWallet();
  const toast = useToast();
  const [mode, setMode] = useState<Mode>("add");
  const [amount0, setAmount0] = useState("");
  const [amount1, setAmount1] = useState("");
  const [shares, setShares] = useState("");
  const [busy, setBusy] = useState(false);
  const [position, setPosition] = useState<{shares: bigint; share0: bigint; share1: bigint} | null>(null);

  /* -------------------------- the user's position -------------------------- */

  useEffect(() => {
    if (!wallet.address) {
      setPosition(null);
      return;
    }
    let cancelled = false;

    void (async () => {
      try {
        const contract = liquidityPoolRead(config, pool.address);
        const balance: bigint = await contract.balanceOf(wallet.address);
        const [share0, share1] = (await contract.previewRemoveLiquidity(balance)) as [bigint, bigint];
        if (!cancelled) setPosition({shares: balance, share0, share1});
      } catch {
        if (!cancelled) setPosition(null);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [wallet.address, config, pool.totalSupply]);

  /* -------- keep the two inputs on the pool ratio, like the contract -------- */

  const reserve0 = BigInt(pool.token0.reserve);
  const reserve1 = BigInt(pool.token1.reserve);

  function syncFrom0(value: string): void {
    setAmount0(value);
    if (reserve0 === 0n) return;
    const parsed = parseAmount(value, pool.token0.decimals);
    setAmount1(parsed === 0n ? "" : formatUnits((parsed * reserve1) / reserve0, pool.token1.decimals));
  }

  function syncFrom1(value: string): void {
    setAmount1(value);
    if (reserve1 === 0n) return;
    const parsed = parseAmount(value, pool.token1.decimals);
    setAmount0(parsed === 0n ? "" : formatUnits((parsed * reserve0) / reserve1, pool.token0.decimals));
  }

  const parsed0 = useMemo(() => parseAmount(amount0, pool.token0.decimals), [amount0, pool.token0.decimals]);
  const parsed1 = useMemo(() => parseAmount(amount1, pool.token1.decimals), [amount1, pool.token1.decimals]);
  const parsedShares = useMemo(() => parseAmount(shares, 18), [shares]);

  /* -------------------------------- actions -------------------------------- */

  async function addLiquidity(): Promise<void> {
    setBusy(true);
    const pending = toast.push({kind: "pending", title: "Adding liquidity", body: "Approving tokens…"});

    try {
      const signer = await wallet.getSigner();
      const poolContract = liquidityPoolWrite(pool.address, signer);

      // Approve only what this deposit needs — no unlimited allowances.
      for (const [token, amount] of [
        [pool.token0, parsed0],
        [pool.token1, parsed1],
      ] as const) {
        const erc20 = erc20Write(token.address, signer);
        const current: bigint = await erc20.allowance(wallet.address, pool.address);
        if (current < amount) {
          const approval = await erc20.approve(pool.address, amount);
          await approval.wait();
        }
      }

      toast.update(pending, {title: "Adding liquidity", body: "Depositing into the pool…"});

      const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
      // 1% tolerance on the rebalanced side: the ratio can move between quote and mine.
      const tx = await poolContract.addLiquidity(
        parsed0,
        parsed1,
        (parsed0 * 99n) / 100n,
        (parsed1 * 99n) / 100n,
        wallet.address,
        deadline,
      );
      const receipt = await tx.wait();

      toast.update(pending, {
        kind: "success",
        title: "Liquidity added",
        href: explorerTxUrl(DEFAULT_CHAIN_ID, receipt.hash) ?? undefined,
      });
      setAmount0("");
      setAmount1("");
      onChanged();
    } catch (error) {
      toast.update(pending, {kind: "error", title: "Could not add liquidity", body: describeContractError(error)});
    } finally {
      setBusy(false);
    }
  }

  async function removeLiquidity(): Promise<void> {
    setBusy(true);
    const pending = toast.push({kind: "pending", title: "Removing liquidity"});

    try {
      const signer = await wallet.getSigner();
      const poolContract = liquidityPoolWrite(pool.address, signer);
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);

      const tx = await poolContract.removeLiquidity(parsedShares, 0, 0, wallet.address, deadline);
      const receipt = await tx.wait();

      toast.update(pending, {
        kind: "success",
        title: "Liquidity removed",
        href: explorerTxUrl(DEFAULT_CHAIN_ID, receipt.hash) ?? undefined,
      });
      setShares("");
      onChanged();
    } catch (error) {
      toast.update(pending, {kind: "error", title: "Could not remove liquidity", body: describeContractError(error)});
    } finally {
      setBusy(false);
    }
  }

  /* -------------------------------- render --------------------------------- */

  const sharePct =
    position && BigInt(pool.totalSupply) > 0n
      ? (Number(position.shares) / Number(BigInt(pool.totalSupply))) * 100
      : 0;

  return (
    <div className="card sticky top-20 p-5">
      <Tabs<Mode>
        active={mode}
        onChange={setMode}
        tabs={[
          {id: "add", label: "Add"},
          {id: "remove", label: "Remove"},
        ]}
      />

      {position && position.shares > 0n ? (
        <div className="mt-4 rounded-xl border border-white/5 bg-ink-950/50 p-3.5">
          <p className="label">Your position</p>
          <p className="tabular mt-1 text-lg font-semibold text-white">
            {formatAmount(position.shares, 18, 4)} LP
          </p>
          <p className="mt-0.5 text-[11px] text-slate-500">
            {sharePct.toFixed(4)}% of the pool · {formatAmount(position.share0, pool.token0.decimals, 2)}{" "}
            {pool.token0.symbol} + {formatAmount(position.share1, pool.token1.decimals, 2)}{" "}
            {pool.token1.symbol}
          </p>
        </div>
      ) : null}

      {mode === "add" ? (
        <div className="mt-4 space-y-3">
          <AmountField
            label={pool.token0.symbol}
            value={amount0}
            onChange={syncFrom0}
            config={config}
            tokenAddress={pool.token0.address}
            decimals={pool.token0.decimals}
            owner={wallet.address}
          />
          <AmountField
            label={pool.token1.symbol}
            value={amount1}
            onChange={syncFrom1}
            config={config}
            tokenAddress={pool.token1.address}
            decimals={pool.token1.decimals}
            owner={wallet.address}
          />
          <p className="text-[11px] text-slate-600">
            Amounts stay matched to the pool ratio. The contract rebalances any surplus back to you
            rather than taking it.
          </p>
          <ActionButton
            wallet={wallet}
            busy={busy}
            disabled={parsed0 === 0n || parsed1 === 0n}
            onClick={addLiquidity}
            label="Add liquidity"
          />
        </div>
      ) : (
        <div className="mt-4 space-y-3">
          <div className="rounded-xl border border-white/5 bg-ink-950/50 p-3.5">
            <div className="flex items-center justify-between">
              <span className="label">LP tokens</span>
              {position ? (
                <button
                  type="button"
                  onClick={() => setShares(formatUnits(position.shares, 18))}
                  className="text-[11px] text-flare-300 hover:text-flare-200"
                >
                  Max
                </button>
              ) : null}
            </div>
            <input
              type="text"
              inputMode="decimal"
              value={shares}
              onChange={(event) => setShares(event.target.value.replace(/[^\d.]/g, ""))}
              placeholder="0.0"
              aria-label="LP tokens to burn"
              className="tabular mt-2 w-full bg-transparent text-2xl font-semibold text-white outline-none placeholder:text-slate-700"
            />
          </div>
          <ActionButton
            wallet={wallet}
            busy={busy}
            disabled={parsedShares === 0n}
            onClick={removeLiquidity}
            label="Remove liquidity"
          />
        </div>
      )}
    </div>
  );
}

function AmountField({
  label,
  value,
  onChange,
  config,
  tokenAddress,
  decimals,
  owner,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  config: AppConfig;
  tokenAddress: string;
  decimals: number;
  owner: string | null;
}) {
  const [balance, setBalance] = useState<bigint | null>(null);

  useEffect(() => {
    if (!owner) {
      setBalance(null);
      return;
    }
    let cancelled = false;
    void erc20Read(tokenAddress, config)
      .balanceOf(owner)
      .then((raw: bigint) => {
        if (!cancelled) setBalance(raw);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [owner, tokenAddress, config]);

  return (
    <div className="rounded-xl border border-white/5 bg-ink-950/50 p-3.5">
      <div className="flex items-center justify-between">
        <span className="label">{label}</span>
        {balance !== null ? (
          <button
            type="button"
            onClick={() => onChange(formatUnits(balance, decimals))}
            className="text-[11px] text-slate-500 hover:text-flare-300"
          >
            Balance {formatAmount(balance, decimals, 4)}
          </button>
        ) : null}
      </div>
      <input
        type="text"
        inputMode="decimal"
        value={value}
        onChange={(event) => onChange(event.target.value.replace(/[^\d.]/g, ""))}
        placeholder="0.0"
        aria-label={`${label} amount`}
        className="tabular mt-2 w-full bg-transparent text-2xl font-semibold text-white outline-none placeholder:text-slate-700"
      />
    </div>
  );
}

function ActionButton({
  wallet,
  busy,
  disabled,
  onClick,
  label,
}: {
  wallet: ReturnType<typeof useWallet>;
  busy: boolean;
  disabled: boolean;
  onClick: () => Promise<void>;
  label: string;
}) {
  if (!wallet.address) {
    return (
      <button type="button" onClick={() => void wallet.connect()} className="btn-primary w-full">
        Connect wallet
      </button>
    );
  }
  if (!wallet.isCorrectChain) {
    return (
      <button type="button" onClick={() => void wallet.switchChain()} className="btn-primary w-full">
        Switch network
      </button>
    );
  }
  return (
    <button type="button" onClick={() => void onClick()} disabled={busy || disabled} className="btn-primary w-full">
      {busy ? (
        <>
          <Spinner /> Working…
        </>
      ) : (
        label
      )}
    </button>
  );
}
