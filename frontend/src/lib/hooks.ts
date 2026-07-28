"use client";

import {useCallback, useEffect, useRef, useState} from "react";
import {WS_URL} from "./constants";
import {api} from "./api";
import type {
  AppConfig,
  DepositInstructions,
  IntentEvent,
  IntentRecord,
  PriceSnapshot,
  ProtocolStats,
  ServerMessage,
} from "./types";

/* -------------------------------------------------------------------------- */
/*                              generic fetching                              */
/* -------------------------------------------------------------------------- */

export interface AsyncState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
}

/**
 * Small fetch-with-polling hook.
 *
 * `deps` deliberately controls re-fetching rather than the fetcher identity — callers pass
 * inline arrow functions, and keying off those would refetch on every render.
 */
export function useAsync<T>(
  fetcher: () => Promise<T>,
  deps: unknown[] = [],
  options: {pollMs?: number; enabled?: boolean} = {},
): AsyncState<T> {
  const {pollMs, enabled = true} = options;
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [nonce, setNonce] = useState(0);

  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    let cancelled = false;

    const run = async (showSpinner: boolean) => {
      if (showSpinner) setLoading(true);
      try {
        const result = await fetcherRef.current();
        if (!cancelled) {
          setData(result);
          setError(null);
        }
      } catch (cause) {
        // Keep the last good data on screen; a transient backend blip should not blank the UI.
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void run(true);

    if (!pollMs) return () => {
      cancelled = true;
    };

    const timer = setInterval(() => void run(false), pollMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce, pollMs, enabled]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return {data, error, loading, reload};
}

/* -------------------------------------------------------------------------- */
/*                                 websocket                                  */
/* -------------------------------------------------------------------------- */

type MessageHandler = (message: ServerMessage) => void;

/**
 * One shared WebSocket for the whole app.
 *
 * Every page wants live prices and most want live intent updates; opening a socket per hook
 * would multiply connections by the number of mounted components. A module-level singleton with
 * refcounted subscribers keeps it to one, and reconnects with backoff when the backend restarts.
 */
class LiveConnection {
  private socket: WebSocket | null = null;
  private handlers = new Set<MessageHandler>();
  private reconnectDelay = 1_000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private shouldRun = false;

  subscribe(handler: MessageHandler): () => void {
    this.handlers.add(handler);
    this.ensureOpen();
    return () => {
      this.handlers.delete(handler);
      if (this.handlers.size === 0) this.close();
    };
  }

  private ensureOpen(): void {
    if (typeof window === "undefined") return;
    this.shouldRun = true;
    if (this.socket && this.socket.readyState <= WebSocket.OPEN) return;

    try {
      const socket = new WebSocket(WS_URL);
      this.socket = socket;

      socket.onopen = () => {
        this.reconnectDelay = 1_000;
      };
      socket.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data as string) as ServerMessage;
          for (const handler of this.handlers) handler(message);
        } catch {
          /* ignore malformed frames */
        }
      };
      socket.onclose = () => {
        this.socket = null;
        if (this.shouldRun && this.handlers.size > 0) this.scheduleReconnect();
      };
      socket.onerror = () => socket.close();
    } catch {
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.ensureOpen();
    }, this.reconnectDelay);
    // Exponential backoff, capped so a long outage still recovers within 15s of coming back.
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 15_000);
  }

  private close(): void {
    this.shouldRun = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.socket?.close();
    this.socket = null;
  }
}

const live = new LiveConnection();

export function useLiveMessages(handler: MessageHandler): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => live.subscribe((message) => handlerRef.current(message)), []);
}

/* -------------------------------------------------------------------------- */
/*                              domain-specific                               */
/* -------------------------------------------------------------------------- */

/** App config, fetched once and cached for the session — addresses do not change at runtime. */
let configPromise: Promise<AppConfig> | null = null;

export function useAppConfig(): AsyncState<AppConfig> {
  return useAsync<AppConfig>(() => {
    configPromise ??= api.config().catch((error) => {
      configPromise = null; // let a later mount retry after the backend comes up
      throw error;
    });
    return configPromise;
  }, []);
}

/** Live FTSO prices: seeded over REST, then kept fresh by the WebSocket. */
export function usePrices(): {prices: PriceSnapshot[]; bySymbol: Record<string, PriceSnapshot>} {
  const [prices, setPrices] = useState<PriceSnapshot[]>([]);

  useEffect(() => {
    void api.prices().then(setPrices).catch(() => undefined);
  }, []);

  useLiveMessages((message) => {
    if (message.type === "prices") setPrices(message.data);
  });

  const bySymbol: Record<string, PriceSnapshot> = {};
  for (const price of prices) bySymbol[price.symbol] = price;
  return {prices, bySymbol};
}

export function usePrice(symbol: string): PriceSnapshot | null {
  const {bySymbol} = usePrices();
  return bySymbol[symbol] ?? null;
}

export function useStats(): ProtocolStats | null {
  const [stats, setStats] = useState<ProtocolStats | null>(null);

  useEffect(() => {
    void api.stats().then(setStats).catch(() => undefined);
  }, []);

  useLiveMessages((message) => {
    if (message.type === "stats") setStats(message.data);
  });

  return stats;
}

/**
 * A single intent plus its event log, updated live.
 *
 * Falls back to a 5s poll as well as the socket: the settlement moment is the one the user is
 * actually watching, and a dropped frame there is the worst possible time to be stale.
 */
export function useLiveIntent(intentId: string | null): {
  intent: IntentRecord | null;
  events: IntentEvent[];
  depositInstructions: DepositInstructions | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
} {
  const {data, error, loading, reload} = useAsync(
    () => (intentId ? api.intent(intentId) : Promise.resolve(null)),
    [intentId],
    {pollMs: 5_000, enabled: Boolean(intentId)},
  );

  const [liveIntent, setLiveIntent] = useState<IntentRecord | null>(null);
  const [liveEvents, setLiveEvents] = useState<IntentEvent[]>([]);

  useEffect(() => {
    setLiveIntent(null);
    setLiveEvents([]);
  }, [intentId]);

  useLiveMessages((message) => {
    if (!intentId) return;
    const id = intentId.toLowerCase();
    if (message.type === "intent" && message.data.intentId.toLowerCase() === id) {
      setLiveIntent(message.data);
    }
    if (message.type === "intent:event" && message.data.intentId.toLowerCase() === id) {
      setLiveEvents((existing) =>
        existing.some((event) => event.id === message.data.id) ? existing : [...existing, message.data],
      );
    }
  });

  const merged = liveIntent ?? data?.intent ?? null;
  const events = mergeEvents(data?.events ?? [], liveEvents);

  return {
    intent: merged,
    events,
    depositInstructions: data?.depositInstructions ?? null,
    loading,
    error,
    reload,
  };
}

function mergeEvents(fetched: IntentEvent[], live: IntentEvent[]): IntentEvent[] {
  const byId = new Map<number, IntentEvent>();
  for (const event of [...fetched, ...live]) byId.set(event.id, event);
  return [...byId.values()].sort((a, b) => a.id - b.id);
}

/** Ticks once a second so countdowns and relative times stay honest. */
export function useNow(intervalMs = 1_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/** Debounces a value — used so the quote endpoint is not hit on every keystroke. */
export function useDebounced<T>(value: T, delayMs = 350): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

export function useCopyToClipboard(): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false);

  const copy = useCallback((text: string) => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1_600);
    });
  }, []);

  return [copied, copy];
}
