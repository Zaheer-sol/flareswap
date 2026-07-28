import {API_BASE} from "./constants";
import type {
  AppConfig,
  IntentDetail,
  IntentRecord,
  IntentStatus,
  PoolStats,
  PriceSnapshot,
  ProtocolStats,
  QuoteResult,
} from "./types";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function get<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {Accept: "application/json", ...init?.headers},
    cache: "no-store",
  });

  const text = await response.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new ApiError(response.status, `Backend returned non-JSON: ${text.slice(0, 120)}`);
  }

  if (!response.ok) {
    const message = (body as {error?: string}).error ?? response.statusText;
    throw new ApiError(response.status, message);
  }
  return body as T;
}

export const api = {
  config: () => get<AppConfig>("/api/config"),

  health: () =>
    get<{ok: boolean; chainId: number; deployed: boolean; prices: boolean}>("/health"),

  prices: () => get<{prices: PriceSnapshot[]}>("/api/prices").then((r) => r.prices),

  /**
   * Quotes come from `IntentSettler.quote` on-chain rather than being recomputed here, so what
   * the UI shows and what the contract will enforce cannot drift apart.
   */
  quote: (params: {amountDrops: string; to: string; slippageBps: number; sourceChain?: number}) =>
    get<QuoteResult>(
      `/api/quote?${new URLSearchParams({
        amount: params.amountDrops,
        to: params.to,
        slippageBps: String(params.slippageBps),
        sourceChain: String(params.sourceChain ?? 0),
      })}`,
    ),

  intents: (params: {user?: string; status?: IntentStatus[]; limit?: number; offset?: number} = {}) => {
    const search = new URLSearchParams();
    if (params.user) search.set("user", params.user);
    if (params.status?.length) search.set("status", params.status.join(","));
    if (params.limit) search.set("limit", String(params.limit));
    if (params.offset) search.set("offset", String(params.offset));
    return get<{intents: IntentRecord[]; total: number}>(`/api/intents?${search}`);
  },

  intent: (id: string) => get<IntentDetail>(`/api/intents/${id}`),

  retryIntent: (id: string) =>
    get<{intent: IntentRecord}>(`/api/intents/${id}/retry`, {method: "POST"}),

  pool: (token?: string) =>
    get<PoolStats>(token ? `/api/pool?token=${token}` : "/api/pool"),

  pools: () => get<{pools: PoolStats[]}>("/api/pools").then((r) => r.pools),

  stats: () => get<ProtocolStats>("/api/stats"),
};
