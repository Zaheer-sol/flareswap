import {config, canRelay} from "./config.js";
import {createLogger, describeError} from "./lib/logger.js";
import {createServer, warmUp} from "./api/server.js";
import {priceService} from "./services/priceService.js";
import {indexer} from "./services/indexer.js";
import {relayer} from "./services/relayer.js";
import {closeDb} from "./db/index.js";

const log = createLogger("main");

/**
 * Boots the three services in one process:
 *
 *   * **Price API** — polls FTSOv2 and serves quotes,
 *   * **Indexer**   — mirrors on-chain intent state into SQLite,
 *   * **Relayer**   — carries deposits from XRPL through the FDC to settlement.
 *
 * They are independent by design. Running without `RELAYER_PRIVATE_KEY` gives a read-only
 * instance that still serves the whole frontend, which is what you want for a public
 * deployment where only one node should be relaying.
 */
async function main(): Promise<void> {
  log.info(`FlareSwap backend starting on chain ${config.chainId}`);

  if (!config.deployment) {
    log.warn(
      `No deployments/${config.chainId}.json found. Read endpoints will 503 until you run ` +
        `'forge script script/Deploy.s.sol:Deploy --broadcast'.`,
    );
  } else {
    await warmUp();
    log.info(`IntentManager ${config.deployment.intentManager}`);
    log.info(`IntentSettler ${config.deployment.intentSettler}`);
  }

  await priceService.start();
  await indexer.start();

  if (canRelay()) {
    await relayer.start();
  } else {
    log.warn("running read-only: no relaying, no settlement");
  }

  const server = createServer();
  await new Promise<void>((resolve) => server.listen(config.api.port, resolve));
  log.info(`API listening on http://localhost:${config.api.port}`);
  log.info(`WebSocket on ws://localhost:${config.api.port}/ws`);

  const shutdown = async (signal: string): Promise<void> => {
    log.info(`${signal} received — shutting down`);
    priceService.stop();
    indexer.stop();
    await relayer.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeDb();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  // A rejected promise deep in a service must not silently kill a background loop.
  process.on("unhandledRejection", (reason) => {
    log.error("unhandled rejection", describeError(reason));
  });
}

main().catch((error) => {
  log.error(`fatal: ${describeError(error)}`);
  process.exit(1);
});
