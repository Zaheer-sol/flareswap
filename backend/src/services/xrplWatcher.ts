import {Client, type TransactionStream} from "xrpl";
import {config} from "../config.js";
import {createLogger, describeError} from "../lib/logger.js";
import {parseDeposit, type ObservedDeposit} from "../lib/xrplUtils.js";

const log = createLogger("xrpl");

export type DepositHandler = (deposit: ObservedDeposit) => Promise<void>;

/**
 * Watches the XRPL deposit address for incoming payments.
 *
 * Two paths feed the same handler, deliberately:
 *
 *   * a **live subscription**, which is how deposits are normally noticed within a ledger close
 *     (~4s) and is what makes the demo feel instant;
 *   * a **backfill sweep** over `account_tx` on connect and on a slow timer, which recovers
 *     anything that arrived while the process was down or while the socket was reconnecting.
 *
 * The handler must therefore be idempotent — it is, because it keys off the XRPL transaction
 * hash, which has a unique index in the database.
 */
export class XrplWatcher {
  private client: Client | null = null;
  private handler: DepositHandler | null = null;
  private backfillTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private lastLedgerScanned = 0;

  constructor(
    private readonly wsUrl: string = config.xrpl.wsUrl,
    private readonly depositAddress: string = config.xrpl.depositAddress,
  ) {}

  onDeposit(handler: DepositHandler): void {
    this.handler = handler;
  }

  async start(): Promise<void> {
    if (!this.depositAddress) {
      log.warn("XRPL_DEPOSIT_ADDRESS is not set — deposit watching disabled");
      return;
    }
    this.stopped = false;
    await this.connect();

    // Slow sweep as a safety net; the subscription does the real work.
    this.backfillTimer = setInterval(() => {
      void this.backfill(50).catch((error) => log.debug("backfill failed", describeError(error)));
    }, 60_000);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.backfillTimer) clearInterval(this.backfillTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.client?.isConnected()) await this.client.disconnect();
    this.client = null;
  }

  get connected(): boolean {
    return this.client?.isConnected() ?? false;
  }

  /* ---------------------------------------------------------------- */

  private async connect(): Promise<void> {
    if (this.stopped) return;
    try {
      this.client = new Client(this.wsUrl, {connectionTimeout: 15_000});

      this.client.on("transaction", (stream) => {
        void this.onStream(stream).catch((error) =>
          log.error("failed to handle a streamed transaction", describeError(error)),
        );
      });
      this.client.on("disconnected", (code) => {
        log.warn(`disconnected (code ${code}) — reconnecting`);
        this.scheduleReconnect();
      });
      this.client.on("error", (error) => log.warn("client error", describeError(error)));

      await this.client.connect();
      await this.client.request({command: "subscribe", accounts: [this.depositAddress]});

      log.info(`watching ${this.depositAddress} on ${this.wsUrl}`);
      await this.backfill(200);
    } catch (error) {
      log.error(`connect failed: ${describeError(error)}`);
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, 5_000);
  }

  /* ---------------------------------------------------------------- */

  private async onStream(stream: TransactionStream): Promise<void> {
    if (!stream.validated) return; // only act on validated ledgers

    // xrpl.js v4 renamed `transaction` to `tx_json`; accept either so a minor bump can't
    // silently stop the relayer from seeing deposits.
    const raw = stream as unknown as {
      tx_json?: Record<string, unknown>;
      transaction?: Record<string, unknown>;
      hash?: string;
      meta?: unknown;
      ledger_index?: number;
    };
    const tx = raw.tx_json ?? raw.transaction;
    if (!tx) return;

    const hash = String(raw.hash ?? tx.hash ?? "");
    if (!hash) return;

    const deposit = parseDeposit(
      tx,
      raw.meta as never,
      raw.ledger_index ?? 0,
      hash,
    );
    await this.dispatch(deposit);
  }

  /**
   * Replays recent history for the deposit address.
   * @param limit how many transactions back to look.
   */
  async backfill(limit: number): Promise<void> {
    if (!this.client?.isConnected()) return;

    const response = await this.client.request({
      command: "account_tx",
      account: this.depositAddress,
      limit,
      ledger_index_min: this.lastLedgerScanned > 0 ? this.lastLedgerScanned : -1,
      ledger_index_max: -1,
      binary: false,
      forward: false,
    });

    const transactions = response.result.transactions ?? [];
    let maxLedger = this.lastLedgerScanned;

    for (const entry of transactions) {
      const raw = entry as unknown as {
        tx?: Record<string, unknown>;
        tx_json?: Record<string, unknown>;
        hash?: string;
        meta?: unknown;
        validated?: boolean;
        ledger_index?: number;
      };
      if (raw.validated === false) continue;

      const tx = raw.tx_json ?? raw.tx;
      if (!tx) continue;

      const hash = String(raw.hash ?? tx.hash ?? "");
      const ledgerIndex = raw.ledger_index ?? Number(tx.ledger_index ?? 0);
      if (!hash) continue;

      if (ledgerIndex > maxLedger) maxLedger = ledgerIndex;
      await this.dispatch(parseDeposit(tx, raw.meta as never, ledgerIndex, hash));
    }

    // Rescan the last ledger next time: transactions inside it may still be arriving.
    if (maxLedger > 0) this.lastLedgerScanned = Math.max(0, maxLedger - 1);
  }

  private async dispatch(deposit: ObservedDeposit | null): Promise<void> {
    if (!deposit || !this.handler) return;
    if (deposit.destination !== this.depositAddress) return;
    if (!deposit.amountDrops) return; // issued-currency payment, not XRP

    await this.handler(deposit);
  }
}

export const xrplWatcher = new XrplWatcher();
