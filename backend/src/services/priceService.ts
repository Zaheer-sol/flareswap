import {formatUnits, toUtf8Bytes, hexlify} from "ethers";
import {config} from "../config.js";
import {priceOracle} from "../lib/flare.js";
import {bus} from "../lib/bus.js";
import {createLogger, describeError} from "../lib/logger.js";
import type {PriceSnapshot} from "../types.js";

const log = createLogger("prices");

/**
 * Builds an FTSOv2 feed id: `0x01` (crypto) + the ASCII name, right-padded to 20 bytes.
 * Mirrors `FeedIds.toFeedId` in Solidity.
 */
export function feedId(name: string): string {
  const nameHex = hexlify(toUtf8Bytes(name)).slice(2);
  if (nameHex.length > 40) throw new Error(`feed name too long: ${name}`);
  return `0x01${nameHex.padEnd(40, "0")}`;
}

export const FEEDS: {symbol: string; name: string}[] = [
  {symbol: "XRP", name: "XRP/USD"},
  {symbol: "FLR", name: "FLR/USD"},
  {symbol: "USDC", name: "USDC/USD"},
  {symbol: "BTC", name: "BTC/USD"},
  {symbol: "ETH", name: "ETH/USD"},
];

/**
 * Polls FTSOv2 and serves the last good value from memory.
 *
 * The frontend re-quotes on every keystroke; doing that against an RPC node would be both slow
 * and rate-limited. Caching here is safe because it is only ever used for *display* and for
 * sizing an intent — the binding price check happens inside `IntentSettler`, reading FTSO
 * directly at settlement time.
 */
class PriceService {
  private readonly snapshots = new Map<string, PriceSnapshot>();
  private timer: NodeJS.Timeout | null = null;
  private consecutiveFailures = 0;

  async start(): Promise<void> {
    if (!config.deployment) {
      log.warn("no deployment for this chain — price polling disabled");
      return;
    }
    await this.refresh();
    this.timer = setInterval(() => {
      void this.refresh();
    }, config.intervals.price);
    log.info(`polling ${FEEDS.length} FTSO feeds every ${config.intervals.price}ms`);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async refresh(): Promise<void> {
    const oracle = priceOracle();
    const results = await Promise.allSettled(
      FEEDS.map(async (feed) => {
        const id = feedId(feed.name);
        const [priceWad, timestamp] = (await oracle.getPriceWad(id)) as [bigint, bigint];
        const snapshot: PriceSnapshot = {
          symbol: feed.symbol,
          feedId: id,
          price: formatUnits(priceWad, 18),
          priceWad: priceWad.toString(),
          decimals: 18,
          timestamp: Number(timestamp),
          ageMs: 0,
        };
        return snapshot;
      }),
    );

    let updated = 0;
    for (const [index, result] of results.entries()) {
      if (result.status === "fulfilled") {
        this.snapshots.set(result.value.symbol, {...result.value, ageMs: 0});
        updated++;
      } else {
        // A single missing feed is normal on testnets; keep serving the last good value.
        log.debug(`feed ${FEEDS[index]!.name} unavailable`, describeError(result.reason));
      }
    }

    if (updated === 0) {
      this.consecutiveFailures++;
      if (this.consecutiveFailures === 1 || this.consecutiveFailures % 30 === 0) {
        log.warn(`all FTSO feeds failed (${this.consecutiveFailures} consecutive attempts)`);
      }
      return;
    }

    if (this.consecutiveFailures > 0) {
      log.info(`FTSO feeds recovered after ${this.consecutiveFailures} failures`);
      this.consecutiveFailures = 0;
    }
    this.lastRefreshMs = Date.now();
    bus.publish({type: "prices", data: this.all()});
  }

  private lastRefreshMs = 0;

  all(): PriceSnapshot[] {
    const age = this.lastRefreshMs ? Date.now() - this.lastRefreshMs : 0;
    return [...this.snapshots.values()].map((snapshot) => ({...snapshot, ageMs: age}));
  }

  get(symbol: string): PriceSnapshot | null {
    const snapshot = this.snapshots.get(symbol.toUpperCase());
    if (!snapshot) return null;
    return {...snapshot, ageMs: this.lastRefreshMs ? Date.now() - this.lastRefreshMs : 0};
  }

  /** USD value, as a float, of `amount` base units of a token. Display only. */
  usdValue(symbol: string, amount: bigint, decimals: number): number {
    const snapshot = this.get(symbol);
    if (!snapshot) return 0;
    return Number(formatUnits(amount, decimals)) * Number(snapshot.price);
  }

  get healthy(): boolean {
    return this.snapshots.size > 0 && this.consecutiveFailures < 10;
  }
}

export const priceService = new PriceService();
