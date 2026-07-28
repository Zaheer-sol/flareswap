/** Minimal levelled logger — structured enough to grep, small enough to need no dependency. */

const LEVELS = {debug: 10, info: 20, warn: 30, error: 40} as const;
export type LogLevel = keyof typeof LEVELS;

const threshold = LEVELS[(process.env.LOG_LEVEL as LogLevel) ?? "info"] ?? LEVELS.info;

function emit(level: LogLevel, scope: string, message: string, extra?: unknown): void {
  if (LEVELS[level] < threshold) return;
  const time = new Date().toISOString();
  const prefix = `${time} ${level.toUpperCase().padEnd(5)} [${scope}]`;
  if (extra === undefined) {
    console.log(`${prefix} ${message}`);
  } else {
    console.log(`${prefix} ${message}`, typeof extra === "string" ? extra : serialise(extra));
  }
}

/** BigInt is not JSON-serialisable, and this codebase is full of them. */
function serialise(value: unknown): string {
  try {
    return JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? v.toString() : v));
  } catch {
    return String(value);
  }
}

export interface Logger {
  debug(message: string, extra?: unknown): void;
  info(message: string, extra?: unknown): void;
  warn(message: string, extra?: unknown): void;
  error(message: string, extra?: unknown): void;
}

export function createLogger(scope: string): Logger {
  return {
    debug: (m, e) => emit("debug", scope, m, e),
    info: (m, e) => emit("info", scope, m, e),
    warn: (m, e) => emit("warn", scope, m, e),
    error: (m, e) => emit("error", scope, m, e),
  };
}

/** Turns an unknown thrown value into something worth logging. */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as {shortMessage?: string}).shortMessage;
    return cause && cause !== error.message ? `${error.message} (${cause})` : error.message;
  }
  return String(error);
}
