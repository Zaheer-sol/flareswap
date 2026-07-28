import type {EventLog} from "ethers";
import {config, requireDeployment} from "../config.js";
import {intentManager, intentSettler, provider, erc20, explorerTxUrl} from "../lib/flare.js";
import {bus} from "../lib/bus.js";
import {createLogger, describeError} from "../lib/logger.js";
import * as store from "../db/index.js";

const log = createLogger("indexer");

const CURSOR = "indexer:lastBlock";
/** Public RPC nodes commonly cap `eth_getLogs` ranges; 2000 is comfortably under every limit. */
const MAX_BLOCK_RANGE = 2_000;

/**
 * Mirrors on-chain intent state into SQLite.
 *
 * The relayer could work purely from its own bookkeeping, but then an intent created while the
 * backend was down would be invisible forever. Replaying `IntentCreated` from the chain makes
 * the database a derived cache that any restart can rebuild, and makes the frontend's history
 * table trustworthy even if the relayer has been offline.
 */
class Indexer {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private symbolCache = new Map<string, string>();

  async start(): Promise<void> {
    if (!config.deployment) {
      log.warn("no deployment for this chain — indexer disabled");
      return;
    }
    await this.tick();
    this.timer = setInterval(() => {
      void this.tick();
    }, config.intervals.indexer);
    log.info(`indexing from block ${store.getCursor(CURSOR) ?? config.indexerStartBlock}`);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    if (this.running) return; // a slow RPC call must not stack ticks
    this.running = true;
    try {
      await this.scan();
    } catch (error) {
      log.error("scan failed", describeError(error));
    } finally {
      this.running = false;
    }
  }

  private async scan(): Promise<void> {
    const head = await provider.getBlockNumber();
    const stored = store.getCursor(CURSOR);
    let from = stored ? Number(stored) + 1 : config.indexerStartBlock;
    if (from > head) return;

    while (from <= head) {
      const to = Math.min(from + MAX_BLOCK_RANGE - 1, head);
      await this.scanRange(from, to);
      store.setCursor(CURSOR, String(to));
      from = to + 1;
    }
  }

  private async scanRange(fromBlock: number, toBlock: number): Promise<void> {
    const manager = intentManager();
    const settler = intentSettler();

    const [created, cancelled, settled, expired] = await Promise.all([
      manager.queryFilter(manager.filters.IntentCreated!(), fromBlock, toBlock),
      manager.queryFilter(manager.filters.IntentCancelled!(), fromBlock, toBlock),
      settler.queryFilter(settler.filters.IntentSettled!(), fromBlock, toBlock),
      settler.queryFilter(settler.filters.IntentExpired!(), fromBlock, toBlock),
    ]);

    for (const event of created as EventLog[]) await this.onCreated(event);
    for (const event of cancelled as EventLog[]) this.onCancelled(event);
    for (const event of settled as EventLog[]) await this.onSettled(event);
    for (const event of expired as EventLog[]) this.onExpired(event);

    if (created.length || cancelled.length || settled.length || expired.length) {
      log.info(
        `blocks ${fromBlock}-${toBlock}: +${created.length} created, ` +
          `${settled.length} settled, ${cancelled.length} cancelled, ${expired.length} expired`,
      );
    }
  }

  /* ---------------------------------------------------------------- */

  private async onCreated(event: EventLog): Promise<void> {
    const {intentId, user, sourceChain, sourceAmount, destinationToken, minOutputAmount, deadline} =
      event.args as unknown as {
        intentId: string;
        user: string;
        sourceChain: bigint;
        sourceAmount: bigint;
        destinationToken: string;
        minOutputAmount: bigint;
        deadline: bigint;
        xrplDestinationTag: bigint;
      };
    const destinationTag = Number((event.args as unknown as {xrplDestinationTag: bigint}).xrplDestinationTag);

    if (store.getIntent(intentId)) return;

    const block = await event.getBlock();
    // `maxSlippageBps` is not in the event (it would push the log over four indexed topics),
    // so read it from storage. One call per new intent, not per block.
    let maxSlippageBps = 0;
    try {
      const onChain = await intentManager().getIntent(intentId);
      maxSlippageBps = Number(onChain.maxSlippageBps);
    } catch (error) {
      log.debug(`could not read slippage for ${intentId}`, describeError(error));
    }

    const isNew = store.upsertIntent({
      intentId,
      userAddress: user,
      sourceChain: Number(sourceChain),
      sourceToken: "XRP",
      sourceAmount: sourceAmount.toString(),
      destinationToken,
      destinationSymbol: await this.symbolOf(destinationToken),
      minOutputAmount: minOutputAmount.toString(),
      maxSlippageBps,
      deadline: Number(deadline),
      destinationTag,
      createdAt: block.timestamp,
    });

    if (!isNew) return;
    const record = store.getIntent(intentId);
    store.addEvent(
      intentId,
      "created",
      `Intent created on Flare for ${sourceAmount} drops`,
      event.transactionHash,
      explorerTxUrl(event.transactionHash),
    );
    if (record) bus.publish({type: "intent", data: record});
  }

  private onCancelled(event: EventLog): void {
    const intentId = (event.args as unknown as {intentId: string}).intentId;
    const existing = store.getIntent(intentId);
    if (!existing || existing.status === "CANCELLED") return;

    const record = store.updateIntent(intentId, {status: "CANCELLED"});
    store.addEvent(intentId, "cancelled", "Intent cancelled by the user", event.transactionHash);
    if (record) bus.publish({type: "intent", data: record});
  }

  private async onSettled(event: EventLog): Promise<void> {
    const args = event.args as unknown as {
      intentId: string;
      outputAmount: bigint;
      sourceTxId: string;
      mintedAmount: bigint;
      protocolFee: bigint;
    };
    const existing = store.getIntent(args.intentId);
    if (existing?.status === "SETTLED") return;

    const block = await event.getBlock();
    const record = store.updateIntent(args.intentId, {
      status: "SETTLED",
      outputAmount: args.outputAmount.toString(),
      flareTxHash: event.transactionHash,
      settledAt: block.timestamp,
      error: null,
    });
    store.addEvent(
      args.intentId,
      "settled",
      `Delivered ${args.outputAmount} units to the user`,
      event.transactionHash,
      explorerTxUrl(event.transactionHash),
    );
    if (record) bus.publish({type: "intent", data: record});
  }

  private onExpired(event: EventLog): void {
    const intentId = (event.args as unknown as {intentId: string}).intentId;
    const existing = store.getIntent(intentId);
    if (!existing || existing.status === "EXPIRED" || existing.status === "SETTLED") return;

    const record = store.updateIntent(intentId, {status: "EXPIRED"});
    store.addEvent(intentId, "expired", "Intent expired without a valid deposit", event.transactionHash);
    if (record) bus.publish({type: "intent", data: record});
  }

  /* ---------------------------------------------------------------- */

  private async symbolOf(token: string): Promise<string> {
    const key = token.toLowerCase();
    const cached = this.symbolCache.get(key);
    if (cached) return cached;

    const deployment = requireDeployment();
    if (key === deployment.fxrp.toLowerCase()) {
      this.symbolCache.set(key, "FXRP");
      return "FXRP";
    }
    try {
      const symbol: string = await erc20(token).symbol();
      this.symbolCache.set(key, symbol);
      return symbol;
    } catch {
      return "???";
    }
  }
}

export const indexer = new Indexer();
