"use client";

import Link from "next/link";
import { useState } from "react";
import { usePathname } from "next/navigation";
import { useWallet } from "@/lib/wallet";

// Every one of these reads or acts on a connected account — there's nothing
// for a disconnected visitor to do on any of them but hit a wallet prompt.
const GATED_TABS = [
  {href: "/swap", label: "Swap", icon: SwapIcon},
  {href: "/dashboard", label: "Dashboard", icon: DashboardIcon},
  {href: "/pool", label: "Pool", icon: PoolIcon},
  {href: "/explorer", label: "Explorer", icon: ExplorerIcon},
] as const;

const MORE_LINKS = [{href: "/docs", label: "Docs"}] as const;

/**
 * Bottom tab bar for phones. The header's link list is `hidden md:flex`, and
 * behind it sat only a hamburger toggle — one extra tap, every time, to see
 * where you even are. A persistent bar matches what people already expect
 * from a trading app and keeps the active route visible without opening anything.
 */
export function MobileNav() {
  const pathname = usePathname();
  const {address, connect, connecting, hasWallet} = useWallet();
  const [moreOpen, setMoreOpen] = useState(false);
  const moreActive = MORE_LINKS.some((l) => l.href === pathname);

  if (!address) {
    return (
      <nav
        className="fixed inset-x-0 bottom-0 z-40 grid grid-cols-2 border-t border-white/5 bg-ink-950/95 backdrop-blur-lg md:hidden"
        style={{paddingBottom: "env(safe-area-inset-bottom)"}}
        aria-label="Primary"
      >
        <Link
          href="/docs"
          className="flex flex-col items-center gap-1 py-2.5 text-[10px] font-medium"
        >
          <DocsIcon active={pathname === "/docs"} />
          <span className={pathname === "/docs" ? "text-flare-400" : "text-slate-500"}>Docs</span>
        </Link>
        {hasWallet ? (
          <button
            type="button"
            onClick={() => void connect()}
            disabled={connecting}
            className="flex flex-col items-center gap-1 py-2.5 text-[10px] font-medium"
          >
            <WalletIcon active={false} />
            <span className="text-slate-500">{connecting ? "Connecting…" : "Connect wallet"}</span>
          </button>
        ) : (
          <a
            href="https://metamask.io/download/"
            target="_blank"
            rel="noreferrer"
            className="flex flex-col items-center gap-1 py-2.5 text-[10px] font-medium"
          >
            <WalletIcon active={false} />
            <span className="text-slate-500">Install wallet</span>
          </a>
        )}
      </nav>
    );
  }

  return (
    <>
      {moreOpen && (
        <button
          aria-label="Close menu"
          onClick={() => setMoreOpen(false)}
          className="fixed inset-0 z-40 bg-ink-950/70 backdrop-blur-sm md:hidden"
        />
      )}

      {moreOpen && (
        <div className="fixed inset-x-3 bottom-[calc(4.25rem+env(safe-area-inset-bottom))] z-50 overflow-hidden rounded-xl border border-white/10 bg-ink-950 shadow-lg md:hidden">
          {MORE_LINKS.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              onClick={() => setMoreOpen(false)}
              className={`block px-4 py-3 text-sm ${
                pathname === l.href ? "bg-white/5 text-white" : "text-slate-300"
              }`}
            >
              {l.label}
            </Link>
          ))}
        </div>
      )}

      <nav
        className="fixed inset-x-0 bottom-0 z-40 border-t border-white/5 bg-ink-950/95 backdrop-blur-lg md:hidden"
        style={{paddingBottom: "env(safe-area-inset-bottom)"}}
        aria-label="Primary"
      >
        <div className="grid grid-cols-5">
          {GATED_TABS.map((tab) => {
            const active = pathname === tab.href || pathname.startsWith(`${tab.href}/`);
            return (
              <Link
                key={tab.href}
                href={tab.href}
                onClick={() => setMoreOpen(false)}
                className="flex flex-col items-center gap-1 py-2.5 text-[10px] font-medium"
              >
                <tab.icon active={active} />
                <span className={active ? "text-flare-400" : "text-slate-500"}>{tab.label}</span>
              </Link>
            );
          })}
          <button
            type="button"
            onClick={() => setMoreOpen((v) => !v)}
            aria-expanded={moreOpen}
            className="flex flex-col items-center gap-1 py-2.5 text-[10px] font-medium"
          >
            <MoreIcon active={moreOpen || moreActive} />
            <span className={moreOpen || moreActive ? "text-flare-400" : "text-slate-500"}>More</span>
          </button>
        </div>
      </nav>
    </>
  );
}

type IconProps = {active: boolean};
const ACTIVE = "#fb923c"; // flare-400
const IDLE = "#64748b"; // slate-500

function SwapIcon({active}: IconProps) {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={active ? ACTIVE : IDLE} strokeWidth="2.2" aria-hidden>
      <path d="M4 8h11M4 8l4-4M4 8l4 4M20 16H9M20 16l-4-4M20 16l-4 4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function DashboardIcon({active}: IconProps) {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={active ? ACTIVE : IDLE} strokeWidth="2.2" aria-hidden>
      <rect x="4" y="4" width="7" height="7" rx="1.3" />
      <rect x="13" y="4" width="7" height="4.5" rx="1.3" />
      <rect x="13" y="11.5" width="7" height="8.5" rx="1.3" />
      <rect x="4" y="13.5" width="7" height="6.5" rx="1.3" />
    </svg>
  );
}
function PoolIcon({active}: IconProps) {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={active ? ACTIVE : IDLE} strokeWidth="2.2" aria-hidden>
      <circle cx="9" cy="12" r="6" />
      <circle cx="15" cy="12" r="6" />
    </svg>
  );
}
function ExplorerIcon({active}: IconProps) {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={active ? ACTIVE : IDLE} strokeWidth="2.2" aria-hidden>
      <circle cx="11" cy="11" r="7" />
      <path d="M20.5 20.5L16 16" strokeLinecap="round" />
    </svg>
  );
}
function MoreIcon({active}: IconProps) {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill={active ? ACTIVE : IDLE} stroke="none" aria-hidden>
      <circle cx="5" cy="12" r="1.7" />
      <circle cx="12" cy="12" r="1.7" />
      <circle cx="19" cy="12" r="1.7" />
    </svg>
  );
}
function DocsIcon({active}: IconProps) {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={active ? ACTIVE : IDLE} strokeWidth="2.2" aria-hidden>
      <path d="M6 4h9l3 3v13H6z" strokeLinejoin="round" />
      <path d="M9 11h6M9 15h6" strokeLinecap="round" />
    </svg>
  );
}
function WalletIcon({active}: IconProps) {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={active ? ACTIVE : IDLE} strokeWidth="2.2" aria-hidden>
      <rect x="3.5" y="6" width="17" height="13" rx="2.2" />
      <path d="M3.5 10h17" />
      <circle cx="16.5" cy="14" r="1" fill={active ? ACTIVE : IDLE} stroke="none" />
    </svg>
  );
}
