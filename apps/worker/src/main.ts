import { createServer } from "node:http";
import { assetRegistry, ChainRegistry } from "@cixtech/chain-config";
import {
  buildRouter,
  ExternalReconciler,
  FeeSweepService,
  FetchWebhookPoster,
  SqlKillSwitch,
  WebhookDispatcher,
  WebhookEndpointStore,
  WebhookOutbox,
} from "@cixtech/chains";
import { LedgerService, SqlLedgerStore } from "@cixtech/ledger";
import { SqlPoolStore } from "@cixtech/attribution";
import { openDatabase } from "@cixtech/postgres";
import type { Worker } from "bullmq";

import {
  createRedisConnection,
  createQueues,
  upsertRepeatable,
  QUEUE_WEBHOOK_DISPATCH,
  QUEUE_EXTERNAL_RECONCILE,
  QUEUE_FEE_SWEEP,
  QUEUE_POOL_RELEASE,
} from "./queues.js";
import { SqlPoolGroupEnumerator } from "./stores/pool-group-enumerator.js";
import { startWebhookWorker } from "./workers/webhook-worker.js";
import { startReconcilerWorker } from "./workers/reconciler-worker.js";
import { startFeeSweepWorker } from "./workers/fee-sweep-worker.js";
import { startPoolReleaseWorker } from "./workers/pool-release-worker.js";

// ── Config ──────────────────────────────────────────────────────────────────

const WEBHOOK_DISPATCH_INTERVAL_MS = 5_000;
const POOL_RELEASE_INTERVAL_MS = 60_000;
const DEFAULT_FEE_SWEEP_INTERVAL_MS = 6 * 60 * 60_000; // 6 hours
const DEFAULT_RECONCILE_INTERVAL_MS = 5 * 60_000; // 5 minutes

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

  // Fee sweep
  const feeSweepService = new FeeSweepService(sql);

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

  let reconciler: ExternalReconciler;
  if (useChainBalances) {
    log("reconciler using chain balance provider (CIXTECH_RECONCILE_CHAIN_BALANCES=true)");
    const { router } = buildRouter(env, sql);
    reconciler = new ExternalReconciler(
      ledgerForRecon,
      enumerator,
      router.balances,
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
  const feeSweepInterval = Number(
    env["CIXTECH_FEE_SWEEP_INTERVAL_MS"] ?? String(DEFAULT_FEE_SWEEP_INTERVAL_MS),
  );
  const reconcileInterval = Number(
    env["CIXTECH_RECONCILE_INTERVAL_MS"] ?? String(DEFAULT_RECONCILE_INTERVAL_MS),
  );

  await upsertRepeatable(queues.webhookDispatch, "tick", WEBHOOK_DISPATCH_INTERVAL_MS);
  await upsertRepeatable(queues.externalReconcile, "tick", reconcileInterval);
  await upsertRepeatable(queues.feeSweep, "tick", feeSweepInterval);
  await upsertRepeatable(queues.poolRelease, "tick", POOL_RELEASE_INTERVAL_MS);

  log("repeatable schedules registered", {
    [QUEUE_WEBHOOK_DISPATCH]: `${WEBHOOK_DISPATCH_INTERVAL_MS}ms`,
    [QUEUE_EXTERNAL_RECONCILE]: `${reconcileInterval}ms`,
    [QUEUE_FEE_SWEEP]: `${feeSweepInterval}ms`,
    [QUEUE_POOL_RELEASE]: `${POOL_RELEASE_INTERVAL_MS}ms`,
  });

  // ── Start workers ─────────────────────────────────────────────────────────
  const workers: Worker[] = [
    startWebhookWorker(redis, webhookDispatcher, log),
    startReconcilerWorker(redis, reconciler, log),
    startFeeSweepWorker(redis, feeSweepService, log),
    startPoolReleaseWorker(redis, poolReleaseFn, log),
  ];

  log("workers started", {
    count: workers.length,
    queues: [QUEUE_WEBHOOK_DISPATCH, QUEUE_EXTERNAL_RECONCILE, QUEUE_FEE_SWEEP, QUEUE_POOL_RELEASE],
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
