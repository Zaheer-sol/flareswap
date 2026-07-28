"use client";

import type {ReactNode} from "react";
import {useCopyToClipboard} from "@/lib/hooks";
import {shortAddress} from "@/lib/format";

/* --------------------------------- layout --------------------------------- */

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: string;
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div>
        {eyebrow ? (
          <p className="mb-1.5 text-xs font-semibold uppercase tracking-[0.2em] text-flare-400">{eyebrow}</p>
        ) : null}
        <h1 className="text-2xl font-bold tracking-tight text-white sm:text-3xl">{title}</h1>
        {description ? <div className="mt-2 max-w-2xl text-sm text-slate-400">{description}</div> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </header>
  );
}

export function Section({
  title,
  description,
  children,
  actions,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <section className="mb-8">
      <div className="mb-3 flex items-end justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-white">{title}</h2>
          {description ? <p className="mt-0.5 text-xs text-slate-500">{description}</p> : null}
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}

/* ---------------------------------- data ---------------------------------- */

export function StatTile({
  label,
  value,
  sublabel,
  accent,
}: {
  label: string;
  value: ReactNode;
  sublabel?: ReactNode;
  accent?: "flare" | "verify" | "mint";
}) {
  const accentClass =
    accent === "flare"
      ? "text-flare-300"
      : accent === "verify"
        ? "text-verify-300"
        : accent === "mint"
          ? "text-mint-400"
          : "text-white";

  return (
    <div className="card p-4">
      <p className="label">{label}</p>
      <p className={`tabular mt-1.5 text-xl font-semibold ${accentClass}`}>{value}</p>
      {sublabel ? <p className="mt-1 text-xs text-slate-500">{sublabel}</p> : null}
    </div>
  );
}

export function DetailRow({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <div className="flex items-start justify-between gap-4 py-2.5 text-sm">
      <span className="shrink-0 text-slate-500" title={hint}>
        {label}
      </span>
      <span className="min-w-0 text-right text-slate-200">{children}</span>
    </div>
  );
}

/* --------------------------------- states --------------------------------- */

export function Spinner({className = "h-4 w-4"}: {className?: string}) {
  return (
    <span
      className={`inline-block animate-spin rounded-full border-2 border-current border-t-transparent ${className}`}
      role="status"
      aria-label="Loading"
    />
  );
}

export function Skeleton({className = "h-4 w-full"}: {className?: string}) {
  return <div className={`skeleton ${className}`} aria-hidden />;
}

export function EmptyState({
  title,
  description,
  action,
  icon = "◎",
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="card flex flex-col items-center justify-center gap-2 px-6 py-14 text-center">
      <div className="mb-1 text-2xl text-slate-700">{icon}</div>
      <p className="text-sm font-semibold text-slate-300">{title}</p>
      {description ? <p className="max-w-sm text-xs text-slate-500">{description}</p> : null}
      {action ? <div className="mt-3">{action}</div> : null}
    </div>
  );
}

export function ErrorState({message, onRetry}: {message: string; onRetry?: () => void}) {
  return (
    <div className="card border-flare-700/40 bg-flare-900/10 px-5 py-6">
      <p className="text-sm font-semibold text-flare-200">Something went wrong</p>
      <p className="mt-1 break-words text-xs text-slate-400">{message}</p>
      {onRetry ? (
        <button type="button" onClick={onRetry} className="btn-secondary mt-3">
          Try again
        </button>
      ) : null}
    </div>
  );
}

/**
 * Shown whenever the backend is unreachable. Names the exact command to run, because the most
 * common cause by far is the API simply not being started yet.
 */
export function BackendOffline({message}: {message?: string}) {
  return (
    <div className="card border-flare-700/40 bg-flare-900/10 px-5 py-6">
      <p className="text-sm font-semibold text-flare-200">Backend not reachable</p>
      <p className="mt-1 text-xs text-slate-400">
        Start the relayer and price API with <code className="mono text-flare-300">npm run dev</code> in{" "}
        <code className="mono text-flare-300">backend/</code>, and make sure contracts are deployed.
      </p>
      {message ? <p className="mt-2 break-words text-[11px] text-slate-600">{message}</p> : null}
    </div>
  );
}

/* ---------------------------------- links --------------------------------- */

export function ExternalLink({
  href,
  children,
  className = "",
}: {
  href: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className={`inline-flex items-center gap-1 text-flare-300 transition-colors hover:text-flare-200 ${className}`}
    >
      {children}
      <span aria-hidden className="text-[0.7em]">
        ↗
      </span>
    </a>
  );
}

export function CopyButton({value, label = "Copy"}: {value: string; label?: string}) {
  const [copied, copy] = useCopyToClipboard();
  return (
    <button
      type="button"
      onClick={() => copy(value)}
      className="rounded-lg border border-white/10 bg-white/5 px-2 py-1 text-[11px] font-medium text-slate-400 transition-colors hover:border-white/20 hover:text-slate-200"
      aria-label={copied ? "Copied" : label}
    >
      {copied ? "Copied" : label}
    </button>
  );
}

export function AddressChip({
  address,
  href,
  label,
}: {
  address: string;
  href?: string;
  label?: string;
}) {
  return (
    <span className="inline-flex items-center gap-2">
      {label ? <span className="text-slate-500">{label}</span> : null}
      {href ? (
        <ExternalLink href={href} className="mono">
          {shortAddress(address, 6)}
        </ExternalLink>
      ) : (
        <span className="mono text-slate-300">{shortAddress(address, 6)}</span>
      )}
      <CopyButton value={address} />
    </span>
  );
}

/* ---------------------------------- misc ---------------------------------- */

/** Marks a value that came from a Flare protocol rather than from our own backend. */
export function VerifiedByFlare({protocol, children}: {protocol: string; children: ReactNode}) {
  return (
    <span className="inline-flex items-center gap-1.5" title={`Sourced from Flare ${protocol}`}>
      {children}
      <span className="chip border-verify-500/30 bg-verify-500/10 !px-1.5 !py-0.5 text-[10px] text-verify-300">
        {protocol}
      </span>
    </span>
  );
}

export function Tabs<T extends string>({
  tabs,
  active,
  onChange,
}: {
  tabs: {id: T; label: string; count?: number}[];
  active: T;
  onChange: (id: T) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1 rounded-xl border border-white/5 bg-ink-900/60 p-1" role="tablist">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={active === tab.id}
          onClick={() => onChange(tab.id)}
          className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
            active === tab.id
              ? "bg-flare-500/15 text-flare-200"
              : "text-slate-500 hover:bg-white/5 hover:text-slate-300"
          }`}
        >
          {tab.label}
          {tab.count !== undefined ? (
            <span className="ml-1.5 text-slate-600">{tab.count}</span>
          ) : null}
        </button>
      ))}
    </div>
  );
}
