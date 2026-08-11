import { createServer } from "node:http";
import { PoolBalanceCache, SqlPoolStore } from "@cixtech/attribution";
import { ChainRegistry, assetRegistry, chainTokens } from "@cixtech/chain-config";
import {
  ExternalReconciler,
  FetchWebhookPoster,
  SqlKillSwitch,
  WebhookDispatcher,
  WebhookEndpointStore,
  WebhookOutbox,
  buildRouter,
} from "@cixtech/chains";
import { LedgerService, SqlLedgerStore } from "@cixtech/ledger";
import { openDatabase } from "@cixtech/postgres";
import type { Worker } from "bullmq";

import {
  QUEUE_EXTERNAL_RECONCILE,
  QUEUE_POOL_BALANCE,
  QUEUE_POOL_RELEASE,
  QUEUE_WEBHOOK_DISPATCH,
  createQueues,
  createRedisConnection,
  upsertRepeatable,
} from "./queues.js";
import { SqlPoolGroupEnumerator } from "./stores/pool-group-enumerator.js";
import { startPoolBalanceWorker } from "./workers/pool-balance-worker.js";
import { startPoolReleaseWorker } from "./workers/pool-release-worker.js";
import { startReconcilerWorker } from "./workers/reconciler-worker.js";
import { startWebhookWorker } from "./workers/webhook-worker.js";

// ── Config ──────────────────────────────────────────────────────────────────

const WEBHOOK_DISPATCH_INTERVAL_MS = 5_000;
const POOL_RELEASE_INTERVAL_MS = 60_000;
const DEFAULT_RECONCILE_INTERVAL_MS = 5 * 60_000; // 5 minutes
/** Balances back a console table, not a money decision — minutes of staleness is fine. */
const DEFAULT_POOL_BALANCE_INTERVAL_MS = 2 * 60_000; // 2 minutes

function log(msg: string, data?: Record<string, unknown>): void {
  const entry = {
    ts: new Date().toISOString(),
    level: "info",
    msg,
    ...data,
  };
  console.log(JSON.stringify(entry));
}

function logError(msg: string, data?: Record<string, unknown>): void {
  const entry = {
    ts: new Date().toISOString(),
    level: "error",
    msg,
    ...data,
  };
  console.error(JSON.stringify(entry));
}

// ── Bootstrap ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const env = process.env;

  // ── Database ──────────────────────────────────────────────────────────────
  const redisUrl = env["REDIS_URL"];
  if (!redisUrl) {
    throw new Error(
      "REDIS_URL is required for the worker process.\n" +
        "Set REDIS_URL=redis://localhost:6380 in your .env (see docker-compose.yml).",
    );
  }
  const db = openDatabase(env);
  const sql = db.sql;

  // ── Redis ─────────────────────────────────────────────────────────────────
  const redis = createRedisConnection(redisUrl);
  await redis.ping(); // fail fast if Redis is unreachable
  log("redis connected", { url: redisUrl.replace(/\/\/.*@/, "//***@") });

  // ── Queues ────────────────────────────────────────────────────────────────
  const queues = createQueues(redis);

  // Webhook dispatcher
  const webhookOutbox = new WebhookOutbox(sql);
  const webhookEndpoints = new WebhookEndpointStore(sql);
  const webhookDispatcher = new WebhookDispatcher(
    webhookOutbox,
    webhookEndpoints,
    new FetchWebhookPoster(),
  );

  // External reconciler
  const registry = new ChainRegistry();
  const assets = Object.keys(assetRegistry());
  const enumerator = new SqlPoolGroupEnumerator(sql);
  const ledgerForRecon = new LedgerService(new SqlLedgerStore(sql));

  const stubBalanceSource = {
    async balance(_chain: string, _address: string, _asset: string): Promise<bigint> {
      return 0n;
    },
  };
  const useChainBalances = env["CIXTECH_RECONCILE_CHAIN_BALANCES"] === "true";

  // One router serves both the reconciler and the balance cache. Built lazily
  // because a worker with no chain configured must still run the queues that do
  // not touch a chain at all.
  let router: ReturnType<typeof buildRouter> | null = null;
  try {
    router = buildRouter(env, sql);
  } catch (err) {
    log("no chain router available", { error: err instanceof Error ? err.message : String(err) });
  }

  let reconciler: ExternalReconciler;
  if (useChainBalances && router) {
    log("reconciler using chain balance provider (CIXTECH_RECONCILE_CHAIN_BALANCES=true)");
    reconciler = new ExternalReconciler(
      ledgerForRecon,
      enumerator,
      router.router.balances,
      assets,
      new SqlKillSwitch(sql),
    );
  } else {
    log(
      "reconciler running in ledger-only mode (set CIXTECH_RECONCILE_CHAIN_BALANCES=true for on-chain checks)",
    );
    reconciler = new ExternalReconciler(
      ledgerForRecon,
      enumerator,
      stubBalanceSource,
      assets,
      new SqlKillSwitch(sql),
    );
  }

  // Pool release
  const poolStore = new SqlPoolStore(sql);
  const poolReleaseFn = {
    async releaseCooledAddresses(now: Date = new Date()): Promise<number> {
      return poolStore.releaseCooled(now);
    },
  };

  // ── Register repeatable schedules ─────────────────────────────────────────
  const reconcileInterval = Number(
    env["CIXTECH_RECONCILE_INTERVAL_MS"] ?? String(DEFAULT_RECONCILE_INTERVAL_MS),
  );
  const poolBalanceInterval = Number(
    env["CIXTECH_POOL_BALANCE_INTERVAL_MS"] ?? String(DEFAULT_POOL_BALANCE_INTERVAL_MS),
  );

  await upsertRepeatable(queues.webhookDispatch, "tick", WEBHOOK_DISPATCH_INTERVAL_MS);
  await upsertRepeatable(queues.externalReconcile, "tick", reconcileInterval);
  await upsertRepeatable(queues.poolRelease, "tick", POOL_RELEASE_INTERVAL_MS);
  if (router) await upsertRepeatable(queues.poolBalance, "tick", poolBalanceInterval);

  log("repeatable schedules registered", {
    [QUEUE_WEBHOOK_DISPATCH]: `${WEBHOOK_DISPATCH_INTERVAL_MS}ms`,
    [QUEUE_EXTERNAL_RECONCILE]: `${reconcileInterval}ms`,
    [QUEUE_POOL_RELEASE]: `${POOL_RELEASE_INTERVAL_MS}ms`,
    [QUEUE_POOL_BALANCE]: router ? `${poolBalanceInterval}ms` : "disabled (no chain router)",
  });

  // ── Start workers ─────────────────────────────────────────────────────────
  const workers: Worker[] = [
    startWebhookWorker(redis, webhookDispatcher, log),
    startReconcilerWorker(redis, reconciler, log),
    startPoolReleaseWorker(redis, poolReleaseFn, log),
  ];

  // The balance cache needs a chain to read from; without a router the console
  // simply shows no observations rather than the worker failing to start.
  if (router) {
    const chainRouter = router.router;
    workers.push(
      startPoolBalanceWorker(
        redis,
        new PoolBalanceCache(sql),
        chainRouter.balances,
        (chain) => chainTokens(registry.environment, chain).map((t) => t.symbol),
        log,
      ),
    );
  }

  log("workers started", {
    count: workers.length,
    queues: [
      QUEUE_WEBHOOK_DISPATCH,
      QUEUE_EXTERNAL_RECONCILE,
      QUEUE_POOL_RELEASE,
      QUEUE_POOL_BALANCE,
    ],
  });

  // ── Health endpoint ───────────────────────────────────────────────────────
  const port = Number(env["WORKER_PORT"] ?? "3001");
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok", workers: workers.length }));
  });
  server.listen(port, "0.0.0.0", () => {
    log("worker health endpoint listening", { port });
  });

  // ── Graceful shutdown ─────────────────────────────────────────────────────
  const shutdown = async (signal: string) => {
    log("shutting down", { signal });
    server.close();
    await Promise.all(workers.map((w) => w.close()));
    await Promise.all(Object.values(queues).map((q) => q.close()));
    await redis.quit();
    await db.close();
    log("shutdown complete");
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err: unknown) => {
  logError("worker failed to start", {
    error: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});
