import http from "node:http";
import express, {type Request, type Response, type NextFunction} from "express";
import cors from "cors";
import {WebSocketServer, type WebSocket} from "ws";
import {formatUnits, isAddress, getAddress} from "ethers";
import {z} from "zod";

import {config, canRelay, type DestinationToken} from "../config.js";
import {bus} from "../lib/bus.js";
import {createLogger, describeError} from "../lib/logger.js";
import {
  intentSettler,
  liquidityPool,
  erc20,
  provider,
  explorerAddressUrl,
  xrplExplorerTxUrl,
  explorerTxUrl,
} from "../lib/flare.js";
import {standardAddressHash, buildDepositTransaction, dropsToXrp, xrpToDrops} from "../lib/xrplUtils.js";
import * as store from "../db/index.js";
import {priceService} from "../services/priceService.js";
import {relayer} from "../services/relayer.js";
import type {IntentStatus, PoolStats, ProtocolStats, QuoteResult, ServerMessage} from "../types.js";

const log = createLogger("api");

/* -------------------------------------------------------------------------- */
/*                                  helpers                                   */
/* -------------------------------------------------------------------------- */

/** Wraps an async handler so a rejected promise becomes a 500 instead of an unhandled crash. */
function route(handler: (req: Request, res: Response) => Promise<unknown>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    handler(req, res).catch(next);
  };
}

class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const ALL_STATUSES: IntentStatus[] = [
  "PENDING",
  "DEPOSITED",
  "ATTESTATION_REQUESTED",
  "ATTESTATION_READY",
  "SETTLING",
  "SETTLED",
  "EXPIRED",
  "CANCELLED",
  "FAILED",
];

/* -------------------------------------------------------------------------- */
/*                                   server                                   */
/* -------------------------------------------------------------------------- */

export function createServer(): http.Server {
  const app = express();

  app.use(express.json({limit: "128kb"}));
  app.use(
    cors({
      origin: config.api.corsOrigin === "*" ? true : config.api.corsOrigin.split(",").map((s) => s.trim()),
    }),
  );

  /* ------------------------------- health -------------------------------- */

  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      chainId: config.chainId,
      deployed: Boolean(config.deployment),
      prices: priceService.healthy,
      relayer: relayer.status,
      time: Date.now(),
    });
  });

  /* ------------------------------- config -------------------------------- */

  /**
   * Everything the frontend needs to bootstrap: addresses, the deposit address and the token
   * list. Serving this from one endpoint means the UI never hard-codes an address, so a
   * redeploy is picked up by a refresh.
   */
  app.get(
    "/api/config",
    route(async (_req, res) => {
      const deployment = config.deployment;
      if (!deployment) throw new ApiError(503, "no deployment for this chain yet");

      // Symbols and decimals come from the deployment file, which the deploy script wrote from
      // the same TokenSet the contracts were configured with — so the UI cannot drift from what
      // IntentManager will actually accept.
      const tokens = deployment.tokens.map((token) => ({
        address: token.address,
        symbol: token.symbol,
        decimals: token.decimals,
        pool: token.hasPool ? token.pool : null,
        isFAsset: token.address.toLowerCase() === deployment.fxrp.toLowerCase(),
      }));

      res.json({
        chainId: config.chainId,
        rpcUrl: config.flareRpcUrl,
        contracts: {
          intentManager: deployment.intentManager,
          intentSettler: deployment.intentSettler,
          priceOracle: deployment.priceOracle,
          minter: deployment.minter,
        },
        explorers: {
          intentManager: explorerAddressUrl(deployment.intentManager),
          intentSettler: explorerAddressUrl(deployment.intentSettler),
          priceOracle: explorerAddressUrl(deployment.priceOracle),
        },
        fxrp: deployment.fxrp,
        tokens,
        xrpl: {
          depositAddress: config.xrpl.depositAddress,
          depositAddressHash: config.xrpl.depositAddress
            ? standardAddressHash(config.xrpl.depositAddress)
            : null,
          sourceId: config.xrpl.sourceId,
          network: config.xrpl.sourceId.toLowerCase().startsWith("test") ? "testnet" : "mainnet",
        },
        relayerEnabled: canRelay(),
        usesFAssets: deployment.usesFAssets ?? false,
      });
    }),
  );

  /* ------------------------------- prices -------------------------------- */

  app.get("/api/prices", (_req, res) => {
    res.json({prices: priceService.all()});
  });

  app.get("/api/prices/:symbol", (req, res) => {
    const snapshot = priceService.get(req.params.symbol!);
    if (!snapshot) {
      res.status(404).json({error: `no feed for ${req.params.symbol}`});
      return;
    }
    res.json(snapshot);
  });

  /* -------------------------------- quote -------------------------------- */

  const quoteQuery = z.object({
    sourceChain: z.coerce.number().int().min(0).default(0),
    // Either `amount` in base units (drops) or `amountXrp` in whole XRP.
    amount: z.string().regex(/^\d+$/).optional(),
    amountXrp: z.string().optional(),
    to: z.string().refine(isAddress, "not an address"),
    slippageBps: z.coerce.number().int().min(0).max(5000).default(50),
  });

  /**
   * Pre-trade quote, read straight from `IntentSettler.quote`.
   *
   * Deliberately not computed here: the same view function the contract uses at settlement time
   * gives the frontend a number that cannot drift from what the user will actually get.
   */
  app.get(
    "/api/quote",
    route(async (req, res) => {
      const parsed = quoteQuery.safeParse(req.query);
      if (!parsed.success) throw new ApiError(400, parsed.error.issues[0]!.message);
      const {sourceChain, to, slippageBps} = parsed.data;

      const amountDrops = parsed.data.amount ?? (parsed.data.amountXrp ? xrpToDrops(parsed.data.amountXrp) : null);
      if (!amountDrops || BigInt(amountDrops) === 0n) throw new ApiError(400, "amount is required");

      const settler = intentSettler();
      const [expectedOutput, ammOutput, minimumOutput, protocolFee, priceImpactBps] =
        (await settler.quote(sourceChain, amountDrops, getAddress(to), slippageBps)) as bigint[];

      const decimals = Number(await erc20(to).decimals());
      const symbol: string = await erc20(to).symbol();

      const sourceWhole = Number(dropsToXrp(amountDrops));
      const outWhole = Number(formatUnits(ammOutput!, decimals));

      const result: QuoteResult = {
        sourceChain,
        sourceAmount: amountDrops,
        sourceSymbol: "XRP",
        destinationToken: getAddress(to),
        destinationSymbol: symbol,
        expectedOutput: expectedOutput!.toString(),
        ammOutput: ammOutput!.toString(),
        minimumOutput: minimumOutput!.toString(),
        protocolFee: protocolFee!.toString(),
        priceImpactBps: Number(priceImpactBps!),
        rate: sourceWhole > 0 ? (outWhole / sourceWhole).toFixed(8) : "0",
        maxSlippageBps: slippageBps,
      };
      res.json(result);
    }),
  );

  /* ------------------------------- intents ------------------------------- */

  const listQuery = z.object({
    user: z.string().optional(),
    status: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  });

  app.get("/api/intents", (req, res) => {
    const parsed = listQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({error: parsed.error.issues[0]!.message});
      return;
    }
    const {user, limit, offset} = parsed.data;

    const statuses = parsed.data.status
      ? (parsed.data.status.split(",").map((s) => s.trim().toUpperCase()) as IntentStatus[])
      : undefined;
    if (statuses?.some((s) => !ALL_STATUSES.includes(s))) {
      res.status(400).json({error: `status must be one of ${ALL_STATUSES.join(", ")}`});
      return;
    }

    const filters = {user, status: statuses, limit, offset};
    res.json({
      intents: store.listIntents(filters),
      total: store.countIntents({user, status: statuses}),
      limit,
      offset,
    });
  });

  app.get("/api/intents/:id", (req, res) => {
    const intent = store.getIntent(req.params.id!);
    if (!intent) {
      res.status(404).json({error: "intent not found"});
      return;
    }

    const events = store.listEvents(intent.intentId);
    res.json({
      intent,
      events,
      links: {
        xrplTx: intent.xrplTxHash ? xrplExplorerTxUrl(intent.xrplTxHash) : null,
        flareTx: intent.flareTxHash ? explorerTxUrl(intent.flareTxHash) : null,
      },
      // The exact XRPL payment the user must sign. Regenerated on every read so a refreshed
      // page always shows a memo that matches the intent.
      depositInstructions:
        intent.status === "PENDING" && config.xrpl.depositAddress
          ? {
              destination: config.xrpl.depositAddress,
              destinationTag: intent.destinationTag,
              amountDrops: intent.sourceAmount,
              amountXrp: dropsToXrp(intent.sourceAmount),
              memoHex: intent.intentId.slice(2).toUpperCase(),
              transaction: buildDepositTransaction({
                account: "",
                destination: config.xrpl.depositAddress,
                amountDrops: intent.sourceAmount,
                intentId: intent.intentId,
                destinationTag: intent.destinationTag,
              }),
            }
          : null,
    });
  });

  /** Nudges one intent through the relayer immediately instead of waiting for the next tick. */
  app.post(
    "/api/intents/:id/retry",
    route(async (req, res) => {
      if (!canRelay()) throw new ApiError(503, "relayer is not enabled on this instance");
      const intent = await relayer.retry(req.params.id!);
      if (!intent) throw new ApiError(404, "intent not found");
      res.json({intent});
    }),
  );

  /* --------------------------------- pool -------------------------------- */

  /** Stats for one pool. `?token=0x…` selects it; omitted, the first configured pool is used. */
  app.get(
    "/api/pool",
    route(async (req, res) => {
      const deployment = config.deployment;
      if (!deployment) throw new ApiError(503, "no deployment for this chain yet");

      const requested = typeof req.query.token === "string" ? req.query.token.toLowerCase() : null;
      const target = requested
        ? deployment.tokens.find((t) => t.address.toLowerCase() === requested)
        : deployment.tokens.find((t) => t.hasPool);

      if (!target) throw new ApiError(404, `no configured token matching ${requested}`);
      if (!target.hasPool) throw new ApiError(400, `${target.symbol} has no pool — it is delivered directly`);

      res.json(await readPool(target));
    }),
  );

  /** Every pool at once, for the /pool page's selector. */
  app.get(
    "/api/pools",
    route(async (_req, res) => {
      const deployment = config.deployment;
      if (!deployment) throw new ApiError(503, "no deployment for this chain yet");

      const pools = await Promise.all(
        deployment.tokens.filter((token) => token.hasPool).map((token) => readPool(token)),
      );
      res.json({pools});
    }),
  );

  /* -------------------------------- stats -------------------------------- */

  app.get("/api/stats", (_req, res) => {
    res.json(buildStats());
  });

  /* ---------------------------- error handling --------------------------- */

  app.use((req, res) => {
    res.status(404).json({error: `no route for ${req.method} ${req.path}`});
  });

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof ApiError) {
      res.status(error.status).json({error: error.message});
      return;
    }
    const message = describeError(error);
    log.error("unhandled error", message);
    res.status(500).json({error: message});
  });

  /* ------------------------------ websocket ------------------------------ */

  const server = http.createServer(app);
  const wss = new WebSocketServer({server, path: "/ws"});

  wss.on("connection", (socket: WebSocket) => {
    send(socket, {type: "hello", data: {chainId: config.chainId, time: Date.now()}});
    send(socket, {type: "prices", data: priceService.all()});
    send(socket, {type: "stats", data: buildStats()});

    const unsubscribe = bus.subscribe((message) => send(socket, message));
    socket.on("close", unsubscribe);
    socket.on("error", unsubscribe);
  });

  // Stats are derived, so recompute on a timer rather than on every intent transition.
  const statsTimer = setInterval(() => {
    if (wss.clients.size > 0) bus.publish({type: "stats", data: buildStats()});
  }, 10_000);
  server.on("close", () => clearInterval(statsTimer));

  return server;
}

function send(socket: WebSocket, message: ServerMessage): void {
  if (socket.readyState !== socket.OPEN) return;
  socket.send(JSON.stringify(message, (_key, value) => (typeof value === "bigint" ? value.toString() : value)));
}

/**
 * Reads one FXRP/<token> pool.
 *
 * Reserve 0 is always FXRP — every pool is constructed with the FAsset as token0 — so the USD
 * value uses the XRP feed for one side and the destination's own feed for the other.
 */
async function readPool(token: DestinationToken): Promise<PoolStats> {
  const deployment = config.deployment!;
  const pool = liquidityPool(token.pool);

  const [reserves, totalSupply, swapFeeBps, swapCount, volume0, volume1, spot] = await Promise.all([
    pool.getReserves() as Promise<[bigint, bigint]>,
    pool.totalSupply() as Promise<bigint>,
    pool.swapFeeBps() as Promise<bigint>,
    pool.swapCount() as Promise<bigint>,
    pool.cumulativeVolume0() as Promise<bigint>,
    pool.cumulativeVolume1() as Promise<bigint>,
    pool.spotPrice0In1() as Promise<bigint>,
  ]);

  const fxrpDecimals = 6;
  const tvl =
    priceService.usdValue("XRP", reserves[0], fxrpDecimals) +
    priceService.usdValue(token.symbol === "WFLR" ? "FLR" : token.symbol, reserves[1], token.decimals);

  return {
    address: token.pool,
    token0: {
      address: deployment.fxrp,
      symbol: "FXRP",
      decimals: fxrpDecimals,
      reserve: reserves[0].toString(),
    },
    token1: {
      address: token.address,
      symbol: token.symbol,
      decimals: token.decimals,
      reserve: reserves[1].toString(),
    },
    totalSupply: totalSupply.toString(),
    swapFeeBps: Number(swapFeeBps),
    swapCount: Number(swapCount),
    cumulativeVolume0: volume0.toString(),
    cumulativeVolume1: volume1.toString(),
    tvlUsd: tvl.toFixed(2),
    spotPrice0In1: spot.toString(),
  };
}

function buildStats(): ProtocolStats {
  const raw = store.computeStats();
  const volumeXrp = dropsToXrp(raw.volumeDrops);
  const xrpPrice = priceService.get("XRP");
  const volumeUsd = xrpPrice ? Number(volumeXrp) * Number(xrpPrice.price) : 0;
  const attempted = raw.settled + raw.failed;

  return {
    totalIntents: raw.total,
    settledIntents: raw.settled,
    pendingIntents: raw.pending,
    failedIntents: raw.failed,
    intentsToday: raw.today,
    totalVolumeXrp: volumeXrp,
    totalVolumeUsd: volumeUsd.toFixed(2),
    averageSettlementSeconds: raw.avgSettlementSeconds,
    successRatePct: attempted === 0 ? 100 : Math.round((raw.settled / attempted) * 100),
  };
}

export async function warmUp(): Promise<void> {
  // Surface a bad RPC URL at boot rather than on the first user request.
  const network = await provider.getNetwork();
  if (Number(network.chainId) !== config.chainId) {
    throw new Error(`RPC reports chain ${network.chainId} but CHAIN_ID is ${config.chainId}`);
  }
}
