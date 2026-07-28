"use client";

import {createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode} from "react";
import {BrowserProvider, JsonRpcSigner} from "ethers";
import {DEFAULT_CHAIN_ID, chainInfo} from "./constants";

/** EIP-1193 provider surface — enough to avoid pulling in a wallet SDK. */
interface Eip1193Provider {
  request(args: {method: string; params?: unknown[] | object}): Promise<unknown>;
  on(event: string, handler: (...args: never[]) => void): void;
  removeListener(event: string, handler: (...args: never[]) => void): void;
  isMetaMask?: boolean;
}

/** EIP-6963 — the standard way to discover wallets when more than one is installed. */
interface Eip6963ProviderDetail {
  info: {uuid: string; name: string; icon: string; rdns: string};
  provider: Eip1193Provider;
}

declare global {
  interface Window {
    ethereum?: Eip1193Provider;
  }
  interface WindowEventMap {
    "eip6963:announceProvider": CustomEvent<Eip6963ProviderDetail>;
  }
}

/**
 * Discovered providers, keyed by RDNS.
 *
 * `window.ethereum` is a single slot that every wallet extension races to claim. With more than
 * one installed the winner is arbitrary, and some inject a proxy that throws opaque errors when
 * another extension has already taken the slot — which is exactly the class of failure that
 * shows up as an unhelpful empty error object. EIP-6963 sidesteps the whole fight: wallets
 * announce themselves and we pick one deliberately.
 */
const discovered = new Map<string, Eip6963ProviderDetail>();

function startDiscovery(): void {
  if (typeof window === "undefined") return;
  window.addEventListener("eip6963:announceProvider", (event) => {
    discovered.set(event.detail.info.rdns, event.detail);
  });
  window.dispatchEvent(new Event("eip6963:requestProvider"));
}

/** Prefers MetaMask when present, then any announced wallet, then the legacy global. */
function pickProvider(): Eip1193Provider | null {
  const metamask = discovered.get("io.metamask");
  if (metamask) return metamask.provider;

  const first = discovered.values().next().value;
  if (first) return first.provider;

  return window.ethereum ?? null;
}

/**
 * Serialises a thrown value so the console shows something usable.
 *
 * `console.error(err)` on an `Error` subclass prints `{}` in Next's dev overlay, because the
 * overlay JSON-serialises and `message`/`stack` are non-enumerable. Wallet RPC errors carry
 * their real payload in `code` and `data`, so those get pulled out by hand.
 */
function serialiseError(cause: unknown): Record<string, unknown> {
  const error = cause as Record<string, unknown> | null | undefined;
  if (error === null || error === undefined) return {value: String(cause)};
  if (typeof error !== "object") return {value: String(cause), type: typeof cause};

  return {
    name: error.name,
    code: error.code,
    message: error.message,
    data: error.data,
    cause: error.cause,
    ownProperties: Object.getOwnPropertyNames(error),
    asString: String(cause),
  };
}

interface WalletState {
  address: string | null;
  chainId: number | null;
  connecting: boolean;
  error: string | null;
  /** Raw serialised failure, shown behind a disclosure so it can be copied into a bug report. */
  diagnostics: string | null;
  hasWallet: boolean;
  isCorrectChain: boolean;
  connect: () => Promise<void>;
  disconnect: () => void;
  switchChain: () => Promise<void>;
  getSigner: () => Promise<JsonRpcSigner>;
  clearError: () => void;
}

const WalletContext = createContext<WalletState | null>(null);

const STORAGE_KEY = "flareswap:connected";

/**
 * Turns an EIP-1193 rejection into something actionable.
 *
 * `-32002` is the one that matters and the one that looks like "the button is broken": the
 * wallet already has a connection request open, so it refuses new ones and does *not* re-focus
 * the popup. Clicking again just queues another rejection, so the user clicks harder and nothing
 * ever happens. The only fix is to open the extension by hand, which the message has to say.
 */
function describeConnectError(cause: unknown): string | null {
  const error = cause as {code?: number | string; message?: string};

  switch (error.code) {
    case 4001:
      // User dismissed the prompt deliberately — not worth a banner.
      return null;
    case -32002:
      return "A connection request is already open. Click the MetaMask icon in your browser toolbar to approve it — the popup does not always come to the front.";
    case 4100:
      return "Your wallet has not authorised this account. Unlock MetaMask and try again.";
    case 4900:
    case 4901:
      return "Your wallet is not connected to any chain. Select a network in MetaMask first.";
    default:
      return error.message ?? "Could not connect to your wallet.";
  }
}

export function WalletProvider({children}: {children: ReactNode}) {
  const [address, setAddress] = useState<string | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [diagnostics, setDiagnostics] = useState<string | null>(null);
  const [hasWallet, setHasWallet] = useState(false);

  /**
   * Wallet detection has to be asynchronous.
   *
   * Extensions inject `window.ethereum` on their own schedule — often after React has already
   * mounted and sometimes after several hundred milliseconds. Reading it once on mount latches
   * `hasWallet` to false for the whole session, and the UI then tells a user who plainly has
   * MetaMask installed to go install MetaMask. So: check immediately, listen for the standard
   * `ethereum#initialized` event, and poll briefly as a backstop for wallets that never emit it.
   */
  useEffect(() => {
    if (typeof window === "undefined") return;

    startDiscovery();

    const detect = (): boolean => {
      const found = Boolean(pickProvider());
      if (found) setHasWallet(true);
      return found;
    };

    if (detect()) return;

    window.addEventListener("ethereum#initialized", detect, {once: true});

    const started = Date.now();
    const timer = setInterval(() => {
      if (detect() || Date.now() - started > 3_000) clearInterval(timer);
    }, 200);

    return () => {
      window.removeEventListener("ethereum#initialized", detect);
      clearInterval(timer);
    };
  }, []);

  const readChain = useCallback(async () => {
    const provider = pickProvider();
    if (!provider) return;
    const hex = (await provider.request({method: "eth_chainId"})) as string;
    setChainId(Number.parseInt(hex, 16));
  }, []);

  /** Reconnects silently on load if the user connected before — no popup unless they ask. */
  useEffect(() => {
    if (localStorage.getItem(STORAGE_KEY) !== "1") return;
    const provider = pickProvider();
    if (!provider) return;

    void (async () => {
      try {
        const accounts = (await provider.request({method: "eth_accounts"})) as string[];
        if (accounts.length > 0) {
          setAddress(accounts[0]!);
          await readChain();
        }
      } catch {
        /* the wallet is locked; leave disconnected */
      }
    })();
  }, [readChain]);

  useEffect(() => {
    const provider = pickProvider();
    if (!provider) return;

    const onAccountsChanged = (...args: never[]) => {
      const accounts = args[0] as unknown as string[];
      if (!accounts || accounts.length === 0) {
        setAddress(null);
        localStorage.removeItem(STORAGE_KEY);
      } else {
        setAddress(accounts[0]!);
      }
    };
    // A chain change invalidates every cached contract read, and wallets recommend a reload.
    const onChainChanged = (...args: never[]) => {
      setChainId(Number.parseInt(args[0] as unknown as string, 16));
    };

    provider.on("accountsChanged", onAccountsChanged);
    provider.on("chainChanged", onChainChanged);
    return () => {
      provider.removeListener("accountsChanged", onAccountsChanged);
      provider.removeListener("chainChanged", onChainChanged);
    };
  }, []);

  const connect = useCallback(async () => {
    setError(null);
    setDiagnostics(null);
    const provider = pickProvider();
    if (!provider) {
      setError("No EVM wallet found. Install MetaMask to continue.");
      return;
    }
    setConnecting(true);
    try {
      const accounts = (await provider.request({method: "eth_requestAccounts"})) as string[];
      if (accounts.length === 0) {
        throw new Error("Your wallet returned no accounts. Unlock it and try again.");
      }
      setAddress(accounts[0]!);
      localStorage.setItem(STORAGE_KEY, "1");
      await readChain();
    } catch (cause) {
      // Log the raw object: the useful fields (code, data) do not survive `String(error)`.
      const detail = serialiseError(cause);
      console.error("[wallet] connect failed", detail);
      console.error("[wallet] providers seen:", [...discovered.keys()], "legacy:", Boolean(window.ethereum));
      setError(describeConnectError(cause));
      setDiagnostics(JSON.stringify(detail));
    } finally {
      setConnecting(false);
    }
  }, [readChain]);

  const disconnect = useCallback(() => {
    setAddress(null);
    localStorage.removeItem(STORAGE_KEY);
  }, []);

  /** Switches to the app's chain, adding it to the wallet first if it is unknown (4902). */
  const switchChain = useCallback(async () => {
    const provider = pickProvider();
    if (!provider) return;
    const target = chainInfo(DEFAULT_CHAIN_ID);
    try {
      await provider.request({
        method: "wallet_switchEthereumChain",
        params: [{chainId: target.chainIdHex}],
      });
    } catch (cause) {
      if ((cause as {code?: number}).code !== 4902) {
        setError(cause instanceof Error ? cause.message : "Could not switch network");
        return;
      }
      await provider.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: target.chainIdHex,
            chainName: target.name,
            nativeCurrency: target.currency,
            rpcUrls: [...target.rpcUrls],
            // Omitted entirely when there is no explorer — MetaMask rejects an empty string
            // here, which would make adding the local devnet fail with an opaque error.
            ...(target.explorer ? {blockExplorerUrls: [target.explorer]} : {}),
          },
        ],
      });
    }
    await readChain();
  }, [readChain]);

  const getSigner = useCallback(async (): Promise<JsonRpcSigner> => {
    const injected = pickProvider();
    if (!injected) throw new Error("No wallet available");
    return new BrowserProvider(injected).getSigner();
  }, []);

  const clearError = useCallback(() => {
    setError(null);
    setDiagnostics(null);
  }, []);

  const value = useMemo<WalletState>(
    () => ({
      address,
      chainId,
      connecting,
      error,
      diagnostics,
      hasWallet,
      isCorrectChain: chainId === DEFAULT_CHAIN_ID,
      connect,
      disconnect,
      switchChain,
      getSigner,
      clearError,
    }),
    [
      address,
      chainId,
      connecting,
      error,
      diagnostics,
      hasWallet,
      connect,
      disconnect,
      switchChain,
      getSigner,
      clearError,
    ],
  );

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet(): WalletState {
  const context = useContext(WalletContext);
  if (!context) throw new Error("useWallet must be used inside <WalletProvider>");
  return context;
}
