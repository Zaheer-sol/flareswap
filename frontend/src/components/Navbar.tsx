"use client";

import Link from "next/link";
import {usePathname} from "next/navigation";
import {useWallet} from "@/lib/wallet";
import {DEFAULT_CHAIN_ID, chainInfo} from "@/lib/constants";
import {shortAddress} from "@/lib/format";

// Swap/Dashboard/Pool/Explorer all read or act on a connected account, so
// there's nothing for a disconnected visitor to do there but hit a wallet
// prompt. Docs is the one page worth reading before you've connected.
const NAV_LINKS = [
  {href: "/swap", label: "Swap", gated: true},
  {href: "/dashboard", label: "Dashboard", gated: true},
  {href: "/pool", label: "Pool", gated: true},
  {href: "/explorer", label: "Explorer", gated: true},
  {href: "/docs", label: "Docs", gated: false},
] as const;

export function Navbar() {
  const pathname = usePathname();
  const {address} = useWallet();
  const links = NAV_LINKS.filter((l) => !l.gated || address);

  return (
    <header className="sticky top-0 z-40 border-b border-white/5 bg-ink-950/80 backdrop-blur-lg">
      <nav className="mx-auto flex h-16 max-w-7xl items-center gap-4 px-4 sm:px-6">
        <Link href="/" className="flex shrink-0 items-center gap-2.5" aria-label="FlareSwap home">
          <Logo />
          <span className="text-base font-bold tracking-tight text-white">
            Flare<span className="text-flare-400">Swap</span>
          </span>
        </Link>

        <ul className="ml-4 hidden items-center gap-1 md:flex">
          {links.map((link) => {
            const active = pathname === link.href || pathname.startsWith(`${link.href}/`);
            return (
              <li key={link.href}>
                <Link
                  href={link.href}
                  className={`rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                    active ? "bg-white/5 text-white" : "text-slate-400 hover:bg-white/5 hover:text-slate-200"
                  }`}
                >
                  {link.label}
                </Link>
              </li>
            );
          })}
        </ul>

        <div className="ml-auto flex items-center gap-2">
          <NetworkIndicator />
          <ConnectButton />
        </div>
      </nav>

      <WalletError />
    </header>
  );
}

/**
 * Surfaces wallet connection failures.
 *
 * Without this the whole failure path is invisible: `connect()` catches the rejection, stores it,
 * and the user sees a button that appears to do nothing no matter how many times they press it.
 * The most common cause — a connection request already open in a popup that did not come to the
 * front — is completely undiagnosable from the UI alone.
 */
function WalletError() {
  const {error, diagnostics, clearError} = useWallet();
  if (!error) return null;

  return (
    <div className="border-t border-flare-600/40 bg-flare-900/30" role="alert">
      <div className="mx-auto flex max-w-7xl items-start gap-3 px-4 py-2.5 sm:px-6">
        <span aria-hidden className="mt-0.5 text-sm text-flare-300">
          !
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-xs leading-relaxed text-flare-100">{error}</p>
          {diagnostics ? (
            <details className="mt-1.5">
              <summary className="cursor-pointer text-[11px] text-flare-300/70 hover:text-flare-200">
                Technical details
              </summary>
              <pre className="mono mt-1.5 max-h-40 overflow-auto rounded-lg border border-white/5 bg-ink-950/70 p-2 text-[10px] leading-relaxed text-slate-400">
                {diagnostics}
              </pre>
            </details>
          ) : null}
        </div>
        <button
          type="button"
          onClick={clearError}
          aria-label="Dismiss"
          className="shrink-0 rounded-lg px-2 py-0.5 text-flare-300 hover:bg-white/5 hover:text-flare-100"
        >
          ×
        </button>
      </div>
    </div>
  );
}

function Logo() {
  return (
    <span
      className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-flare-400 to-flare-600 shadow-glow"
      aria-hidden
    >
      <svg viewBox="0 0 24 24" className="h-4 w-4 text-white" fill="none" stroke="currentColor" strokeWidth="2.5">
        <path d="M4 8h11M4 16h11" strokeLinecap="round" />
        <path d="M16 5l4 3-4 3M16 13l4 3-4 3" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}

function NetworkIndicator() {
  const {chainId, isCorrectChain, switchChain, address} = useWallet();
  const target = chainInfo(DEFAULT_CHAIN_ID);

  // Before connecting there is nothing to be wrong about — just name the target network.
  if (!address) {
    return (
      <span className="chip hidden sm:inline-flex">
        <span className="h-1.5 w-1.5 rounded-full bg-slate-600" />
        {target.name.replace("Flare Testnet ", "")}
      </span>
    );
  }

  if (!isCorrectChain) {
    return (
      <button
        type="button"
        onClick={() => void switchChain()}
        className="chip border-flare-600/50 bg-flare-900/30 text-flare-200 transition-colors hover:bg-flare-900/50"
      >
        <span className="h-1.5 w-1.5 rounded-full bg-flare-400" />
        Switch to {target.name.replace("Flare Testnet ", "")}
      </button>
    );
  }

  return (
    <span className="chip hidden border-mint-500/25 bg-mint-500/10 text-mint-400 sm:inline-flex" title={`Chain ${chainId}`}>
      <span className="h-1.5 w-1.5 rounded-full bg-mint-400" />
      {target.name.replace("Flare Testnet ", "")}
    </span>
  );
}

function ConnectButton() {
  const {address, connect, disconnect, connecting, hasWallet} = useWallet();

  if (address) {
    return (
      <button
        type="button"
        onClick={disconnect}
        className="btn-secondary !px-3 !py-2 font-mono text-xs"
        title="Click to disconnect"
      >
        <span className="h-1.5 w-1.5 rounded-full bg-mint-400" />
        {shortAddress(address)}
      </button>
    );
  }

  if (!hasWallet) {
    return (
      <a
        href="https://metamask.io/download/"
        target="_blank"
        rel="noreferrer"
        className="btn-secondary !px-3 !py-2 text-xs"
      >
        Install wallet
      </a>
    );
  }

  return (
    <button type="button" onClick={() => void connect()} disabled={connecting} className="btn-primary !px-3.5 !py-2 text-xs">
      {connecting ? "Connecting…" : "Connect wallet"}
    </button>
  );
}
