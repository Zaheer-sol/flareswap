import {mkdirSync} from "node:fs";
import {dirname} from "node:path";
import Database from "better-sqlite3";
import {config} from "../config.js";
import {createLogger} from "../lib/logger.js";
import type {IntentEvent, IntentRecord, IntentStatus} from "../types.js";

const log = createLogger("db");

mkdirSync(dirname(config.databasePath), {recursive: true});

export const db = new Database(config.databasePath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

/**
 * The database mirrors on-chain state; it is never the source of truth.
 *
 * Everything here can be rebuilt by replaying `IntentCreated` / `IntentSettled` logs (see
 * `services/indexer.ts`). It exists so the frontend can filter and paginate without hammering
 * an RPC node, and so the relayer can remember where each deposit is inside the FDC pipeline —
 * the one piece of state the chain genuinely does not have.
 */
db.exec(`
CREATE TABLE IF NOT EXISTS intents (
  intent_id           TEXT PRIMARY KEY,
  user_address        TEXT NOT NULL,
  status              TEXT NOT NULL,
  source_chain        INTEGER NOT NULL,
  source_token        TEXT NOT NULL DEFAULT 'XRP',
  source_amount       TEXT NOT NULL,
  destination_token   TEXT NOT NULL,
  destination_symbol  TEXT NOT NULL DEFAULT '',
  min_output_amount   TEXT NOT NULL DEFAULT '0',
  output_amount       TEXT,
  max_slippage_bps    INTEGER NOT NULL DEFAULT 0,
  deadline            INTEGER NOT NULL DEFAULT 0,
  destination_tag     INTEGER NOT NULL DEFAULT 0,
  xrpl_tx_hash        TEXT,
  flare_tx_hash       TEXT,
  attestation_request TEXT,
  voting_round        INTEGER,
  attempts            INTEGER NOT NULL DEFAULT 0,
  error               TEXT,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  settled_at          INTEGER
);

CREATE INDEX IF NOT EXISTS idx_intents_user     ON intents(user_address);
CREATE INDEX IF NOT EXISTS idx_intents_status   ON intents(status);
CREATE INDEX IF NOT EXISTS idx_intents_tag      ON intents(destination_tag);
CREATE INDEX IF NOT EXISTS idx_intents_created  ON intents(created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_intents_xrpl_tx ON intents(xrpl_tx_hash) WHERE xrpl_tx_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS intent_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  intent_id   TEXT NOT NULL,
  kind        TEXT NOT NULL,
  message     TEXT NOT NULL,
  tx_hash     TEXT,
  explorer_url TEXT,
  created_at  INTEGER NOT NULL,
  FOREIGN KEY (intent_id) REFERENCES intents(intent_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_events_intent ON intent_events(intent_id, id);

CREATE TABLE IF NOT EXISTS cursors (
  name  TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);

/* -------------------------------------------------------------------------- */
/*                                  mapping                                   */
/* -------------------------------------------------------------------------- */

interface IntentRow {
  intent_id: string;
  user_address: string;
  status: string;
  source_chain: number;
  source_token: string;
  source_amount: string;
  destination_token: string;
  destination_symbol: string;
  min_output_amount: string;
  output_amount: string | null;
  max_slippage_bps: number;
  deadline: number;
  destination_tag: number;
  xrpl_tx_hash: string | null;
  flare_tx_hash: string | null;
  attestation_request: string | null;
  voting_round: number | null;
  attempts: number;
  error: string | null;
  created_at: number;
  updated_at: number;
  settled_at: number | null;
}

function toRecord(row: IntentRow): IntentRecord {
  return {
    intentId: row.intent_id,
    userAddress: row.user_address,
    status: row.status as IntentStatus,
    sourceChain: row.source_chain,
    sourceToken: row.source_token,
    sourceAmount: row.source_amount,
    destinationToken: row.destination_token,
    destinationSymbol: row.destination_symbol,
    minOutputAmount: row.min_output_amount,
    outputAmount: row.output_amount,
    maxSlippageBps: row.max_slippage_bps,
    deadline: row.deadline,
    destinationTag: row.destination_tag,
    xrplTxHash: row.xrpl_tx_hash,
    flareTxHash: row.flare_tx_hash,
    attestationRequest: row.attestation_request,
    votingRound: row.voting_round,
    attempts: row.attempts,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    settledAt: row.settled_at,
  };
}

const now = (): number => Math.floor(Date.now() / 1000);

/* -------------------------------------------------------------------------- */
/*                                  queries                                   */
/* -------------------------------------------------------------------------- */

const insertIntentStmt = db.prepare(`
INSERT INTO intents (
  intent_id, user_address, status, source_chain, source_token, source_amount,
  destination_token, destination_symbol, min_output_amount, max_slippage_bps,
  deadline, destination_tag, created_at, updated_at
) VALUES (
  @intent_id, @user_address, @status, @source_chain, @source_token, @source_amount,
  @destination_token, @destination_symbol, @min_output_amount, @max_slippage_bps,
  @deadline, @destination_tag, @created_at, @updated_at
)
ON CONFLICT(intent_id) DO NOTHING
`);

export interface NewIntent {
  intentId: string;
  userAddress: string;
  sourceChain: number;
  sourceToken: string;
  sourceAmount: string;
  destinationToken: string;
  destinationSymbol: string;
  minOutputAmount: string;
  maxSlippageBps: number;
  deadline: number;
  destinationTag: number;
  createdAt?: number;
}

/** Idempotent: the indexer re-inserts the same events after a restart. */
export function upsertIntent(intent: NewIntent): boolean {
  const timestamp = intent.createdAt ?? now();
  const result = insertIntentStmt.run({
    intent_id: intent.intentId.toLowerCase(),
    user_address: intent.userAddress.toLowerCase(),
    status: "PENDING" satisfies IntentStatus,
    source_chain: intent.sourceChain,
    source_token: intent.sourceToken,
    source_amount: intent.sourceAmount,
    destination_token: intent.destinationToken.toLowerCase(),
    destination_symbol: intent.destinationSymbol,
    min_output_amount: intent.minOutputAmount,
    max_slippage_bps: intent.maxSlippageBps,
    deadline: intent.deadline,
    destination_tag: intent.destinationTag,
    created_at: timestamp,
    updated_at: timestamp,
  });
  return result.changes > 0;
}

const getIntentStmt = db.prepare<[string], IntentRow>(
  "SELECT * FROM intents WHERE intent_id = ?",
);

export function getIntent(intentId: string): IntentRecord | null {
  const row = getIntentStmt.get(intentId.toLowerCase());
  return row ? toRecord(row) : null;
}

const getByTagStmt = db.prepare<[number], IntentRow>(
  "SELECT * FROM intents WHERE destination_tag = ? ORDER BY created_at DESC LIMIT 1",
);

export function getIntentByDestinationTag(tag: number): IntentRecord | null {
  const row = getByTagStmt.get(tag);
  return row ? toRecord(row) : null;
}

const getByXrplTxStmt = db.prepare<[string], IntentRow>(
  "SELECT * FROM intents WHERE xrpl_tx_hash = ?",
);

export function getIntentByXrplTx(txHash: string): IntentRecord | null {
  const row = getByXrplTxStmt.get(txHash);
  return row ? toRecord(row) : null;
}

export interface ListFilters {
  user?: string;
  status?: IntentStatus | IntentStatus[];
  limit?: number;
  offset?: number;
}

export function listIntents(filters: ListFilters = {}): IntentRecord[] {
  const where: string[] = [];
  const params: unknown[] = [];

  if (filters.user) {
    where.push("user_address = ?");
    params.push(filters.user.toLowerCase());
  }
  if (filters.status) {
    const statuses = Array.isArray(filters.status) ? filters.status : [filters.status];
    where.push(`status IN (${statuses.map(() => "?").join(",")})`);
    params.push(...statuses);
  }

  const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200);
  const offset = Math.max(filters.offset ?? 0, 0);

  const sql = `SELECT * FROM intents ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
               ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`;
  const rows = db.prepare(sql).all(...params, limit, offset) as IntentRow[];
  return rows.map(toRecord);
}

export function countIntents(filters: Omit<ListFilters, "limit" | "offset"> = {}): number {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filters.user) {
    where.push("user_address = ?");
    params.push(filters.user.toLowerCase());
  }
  if (filters.status) {
    const statuses = Array.isArray(filters.status) ? filters.status : [filters.status];
    where.push(`status IN (${statuses.map(() => "?").join(",")})`);
    params.push(...statuses);
  }
  const sql = `SELECT COUNT(*) AS n FROM intents ${where.length ? `WHERE ${where.join(" AND ")}` : ""}`;
  return (db.prepare(sql).get(...params) as {n: number}).n;
}

/** Intents the relayer should look at on its next tick, oldest first. */
export function listActionable(): IntentRecord[] {
  const rows = db
    .prepare(
      `SELECT * FROM intents
       WHERE status IN ('PENDING','DEPOSITED','ATTESTATION_REQUESTED','ATTESTATION_READY','FAILED')
       ORDER BY updated_at ASC LIMIT 100`,
    )
    .all() as IntentRow[];
  return rows.map(toRecord);
}

export interface IntentPatch {
  status?: IntentStatus;
  xrplTxHash?: string | null;
  flareTxHash?: string | null;
  attestationRequest?: string | null;
  votingRound?: number | null;
  outputAmount?: string | null;
  error?: string | null;
  settledAt?: number | null;
  incrementAttempts?: boolean;
}

const COLUMN_FOR: Record<Exclude<keyof IntentPatch, "incrementAttempts">, string> = {
  status: "status",
  xrplTxHash: "xrpl_tx_hash",
  flareTxHash: "flare_tx_hash",
  attestationRequest: "attestation_request",
  votingRound: "voting_round",
  outputAmount: "output_amount",
  error: "error",
  settledAt: "settled_at",
};

export function updateIntent(intentId: string, patch: IntentPatch): IntentRecord | null {
  const sets: string[] = ["updated_at = ?"];
  const params: unknown[] = [now()];

  for (const [key, column] of Object.entries(COLUMN_FOR)) {
    const value = patch[key as keyof IntentPatch];
    if (value === undefined) continue;
    sets.push(`${column} = ?`);
    params.push(value);
  }
  if (patch.incrementAttempts) sets.push("attempts = attempts + 1");

  params.push(intentId.toLowerCase());
  db.prepare(`UPDATE intents SET ${sets.join(", ")} WHERE intent_id = ?`).run(...params);
  return getIntent(intentId);
}

/* -------------------------------- events --------------------------------- */

const insertEventStmt = db.prepare(`
INSERT INTO intent_events (intent_id, kind, message, tx_hash, explorer_url, created_at)
VALUES (?, ?, ?, ?, ?, ?)
`);

export function addEvent(
  intentId: string,
  kind: string,
  message: string,
  txHash: string | null = null,
  explorerUrl: string | null = null,
): IntentEvent {
  const createdAt = now();
  const result = insertEventStmt.run(intentId.toLowerCase(), kind, message, txHash, explorerUrl, createdAt);
  log.debug(`${intentId.slice(0, 10)} ${kind}: ${message}`);
  return {
    id: Number(result.lastInsertRowid),
    intentId: intentId.toLowerCase(),
    kind,
    message,
    txHash,
    explorerUrl,
    createdAt,
  };
}

interface EventRow {
  id: number;
  intent_id: string;
  kind: string;
  message: string;
  tx_hash: string | null;
  explorer_url: string | null;
  created_at: number;
}

const listEventsStmt = db.prepare<[string], EventRow>(
  "SELECT * FROM intent_events WHERE intent_id = ? ORDER BY id ASC",
);

export function listEvents(intentId: string): IntentEvent[] {
  return listEventsStmt.all(intentId.toLowerCase()).map((row) => ({
    id: row.id,
    intentId: row.intent_id,
    kind: row.kind,
    message: row.message,
    txHash: row.tx_hash,
    explorerUrl: row.explorer_url,
    createdAt: row.created_at,
  }));
}

/* -------------------------------- cursors -------------------------------- */

const getCursorStmt = db.prepare<[string], {value: string}>("SELECT value FROM cursors WHERE name = ?");
const setCursorStmt = db.prepare(
  "INSERT INTO cursors (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value",
);

export function getCursor(name: string): string | null {
  return getCursorStmt.get(name)?.value ?? null;
}

export function setCursor(name: string, value: string): void {
  setCursorStmt.run(name, value);
}

/* --------------------------------- stats --------------------------------- */

export interface RawStats {
  total: number;
  settled: number;
  pending: number;
  failed: number;
  today: number;
  volumeDrops: string;
  avgSettlementSeconds: number | null;
}

export function computeStats(): RawStats {
  const dayAgo = now() - 86_400;

  const counts = db
    .prepare(
      `SELECT
         COUNT(*)                                                        AS total,
         SUM(CASE WHEN status = 'SETTLED' THEN 1 ELSE 0 END)             AS settled,
         SUM(CASE WHEN status IN ('PENDING','DEPOSITED','ATTESTATION_REQUESTED','ATTESTATION_READY','SETTLING')
                  THEN 1 ELSE 0 END)                                     AS pending,
         SUM(CASE WHEN status = 'FAILED' THEN 1 ELSE 0 END)              AS failed,
         SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END)                AS today
       FROM intents`,
    )
    .get(dayAgo) as Record<string, number | null>;

  // Volume counts only settled intents — an unpaid intent moved no value.
  const volumeRows = db
    .prepare("SELECT source_amount FROM intents WHERE status = 'SETTLED'")
    .all() as {source_amount: string}[];
  const volumeDrops = volumeRows.reduce((sum, row) => sum + BigInt(row.source_amount), 0n);

  const timing = db
    .prepare(
      `SELECT AVG(settled_at - created_at) AS avg
       FROM intents WHERE status = 'SETTLED' AND settled_at IS NOT NULL`,
    )
    .get() as {avg: number | null};

  return {
    total: counts.total ?? 0,
    settled: counts.settled ?? 0,
    pending: counts.pending ?? 0,
    failed: counts.failed ?? 0,
    today: counts.today ?? 0,
    volumeDrops: volumeDrops.toString(),
    avgSettlementSeconds: timing.avg === null ? null : Math.round(timing.avg),
  };
}

export function closeDb(): void {
  db.close();
}
