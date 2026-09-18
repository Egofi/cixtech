import { createServer } from "node:http";
import { PoolManager, PooledAttribution } from "@/attribution";
import { PoolBalanceCache } from "@/attribution";
import { assetRegistry } from "@/chain-config";
import { ChainRegistry, chainTokens } from "@/chain-config";
import {
  DepositWatcher,
  ExternalReconciler,
  FetchWebhookPoster,
  WebhookDispatcher,
  WebhookEndpointStore,
  WebhookOutbox,
  buildRouter,
} from "@/chains";
import { DepositIngestor } from "@/chains";
import { SqlErrorSink, handleError, resolveError } from "@/common";
import { LedgerService } from "@/services";
import { SqlKillSwitch, SqlLedgerStore, SqlPoolGroupEnumerator, SqlPoolStore } from "@/stores";

import { openDatabase } from "@/postgres";
import type { Worker } from "bullmq";

import {
  QUEUE_DEPOSIT_DETECT,
  QUEUE_EXTERNAL_RECONCILE,
  QUEUE_POOL_BALANCE,
  QUEUE_POOL_RELEASE,
  QUEUE_WEBHOOK_DISPATCH,
  createQueues,
  createRedisConnection,
  removeRepeatable,
  upsertRepeatable,
} from "./queues.js";
import { planExternalReconciliation } from "./reconcile-wiring.js";

import { startDetectionWorker } from "./workers/detection-worker.js";
import { startPoolBalanceWorker } from "./workers/pool-balance-worker.js";
import { startPoolReleaseWorker } from "./workers/pool-release-worker.js";
import { startReconcilerWorker } from "./workers/reconciler-worker.js";
import { startWebhookWorker } from "./workers/webhook-worker.js";

const WEBHOOK_DISPATCH_INTERVAL_MS = 5_000;
const POOL_RELEASE_INTERVAL_MS = 60_000;
const DEFAULT_RECONCILE_INTERVAL_MS = 5 * 60_000;

const DEFAULT_POOL_BALANCE_INTERVAL_MS = 2 * 60_000;

const DEFAULT_DETECTION_INTERVAL_MS = 15_000;

const POOL_COOLDOWN_MS = 30 * 60_000;

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

async function main(): Promise<void> {
  const env = process.env;

  const redisUrl = env["REDIS_URL"];
  if (!redisUrl) {
    throw new Error(
      "REDIS_URL is required for the worker process.\n" +
        "Set REDIS_URL=redis://localhost:6380 in your .env (see docker-compose.yml).",
    );
  }
  const db = openDatabase(env);
  const sql = db.sql;

  const redis = createRedisConnection(redisUrl);
  await redis.ping();
  log("redis connected", { url: redisUrl.replace(/\/\/.*@/, "//***@") });

  const queues = createQueues(redis);

  const webhookOutbox = new WebhookOutbox(sql);
  const webhookEndpoints = new WebhookEndpointStore(sql);
  const webhookDispatcher = new WebhookDispatcher(
    webhookOutbox,
    webhookEndpoints,
    new FetchWebhookPoster(),
  );

  const registry = new ChainRegistry();
  const assets = Object.keys(assetRegistry());
  const enumerator = new SqlPoolGroupEnumerator(sql);
  const ledgerForRecon = new LedgerService(new SqlLedgerStore(sql));

  const useChainBalances = env["CIXTECH_RECONCILE_CHAIN_BALANCES"] === "true";

  let router: ReturnType<typeof buildRouter> | null = null;
  try {
    router = buildRouter(env, sql);
  } catch (err) {
    log("no chain router available", { error: err instanceof Error ? err.message : String(err) });
  }

  const reconcilePlan = planExternalReconciliation({
    chainBalancesEnabled: useChainBalances,
    hasChainRouter: router !== null,
  });

  const reconciler: ExternalReconciler | null =
    reconcilePlan.enabled && router
      ? new ExternalReconciler(
          ledgerForRecon,
          enumerator,
          router.router.balances,
          assets,
          new SqlKillSwitch(sql),
        )
      : null;

  if (reconciler) {
    log("external reconciliation ON", { source: reconcilePlan.reason });
  } else {
    logError(
      [
        "EXTERNAL RECONCILIATION IS NOT RUNNING: the ledger is not being checked against",
        "on-chain balances, so theft, a missed deposit or a posting bug would go undetected.",
        reconcilePlan.reason,
      ].join(" "),
    );
  }

  const feeBasisPoints = Number(env["CIXTECH_FEE_BPS"] ?? "50");
  const detectionInterval = Number(
    env["CIXTECH_DETECTION_INTERVAL_MS"] ?? String(DEFAULT_DETECTION_INTERVAL_MS),
  );

  const poolStore = new SqlPoolStore(sql);
  const poolReleaseFn = {
    async releaseCooledAddresses(now: Date = new Date()): Promise<number> {
      return poolStore.releaseCooled(now);
    },
  };

  const reconcileInterval = Number(
    env["CIXTECH_RECONCILE_INTERVAL_MS"] ?? String(DEFAULT_RECONCILE_INTERVAL_MS),
  );
  const poolBalanceInterval = Number(
    env["CIXTECH_POOL_BALANCE_INTERVAL_MS"] ?? String(DEFAULT_POOL_BALANCE_INTERVAL_MS),
  );

  await upsertRepeatable(queues.webhookDispatch, "tick", WEBHOOK_DISPATCH_INTERVAL_MS);
  await upsertRepeatable(queues.poolRelease, "tick", POOL_RELEASE_INTERVAL_MS);
  if (router) await upsertRepeatable(queues.poolBalance, "tick", poolBalanceInterval);
  if (router) await upsertRepeatable(queues.depositDetect, "tick", detectionInterval);

  // A schedule left over from a run that HAD reconciliation enabled would keep
  // enqueuing jobs no worker consumes, so retire it explicitly when it is off.
  if (reconciler) {
    await upsertRepeatable(queues.externalReconcile, "tick", reconcileInterval);
  } else {
    await removeRepeatable(queues.externalReconcile, "tick");
  }

  log("repeatable schedules registered", {
    [QUEUE_WEBHOOK_DISPATCH]: `${WEBHOOK_DISPATCH_INTERVAL_MS}ms`,
    [QUEUE_EXTERNAL_RECONCILE]: reconciler
      ? `${reconcileInterval}ms`
      : "disabled (no chain balance source)",
    [QUEUE_POOL_RELEASE]: `${POOL_RELEASE_INTERVAL_MS}ms`,
    [QUEUE_POOL_BALANCE]: router ? `${poolBalanceInterval}ms` : "disabled (no chain router)",
    [QUEUE_DEPOSIT_DETECT]: router ? `${detectionInterval}ms` : "disabled (no chain router)",
  });

  if (!router) {
    logError(
      "DEPOSIT DETECTION IS NOT RUNNING: no chain router could be built. " +
        "Set <CHAIN>_RPC_URL and CIXTECH_ENGINE_XPRV — until then, no deposit is credited.",
    );
  }

  const workers: Worker[] = [
    startWebhookWorker(redis, webhookDispatcher, log),
    startPoolReleaseWorker(redis, poolReleaseFn, log),
  ];

  if (reconciler) workers.push(startReconcilerWorker(redis, reconciler, log));

  if (router) {
    const chainRouter = router.router;

    const pool = new PoolManager(new SqlPoolStore(sql), chainRouter.deriveAddress, {
      cooldownMs: POOL_COOLDOWN_MS,
    });
    const ingestor = new DepositIngestor(
      new LedgerService(new SqlLedgerStore(sql)),
      new PooledAttribution(pool, () => feeBasisPoints),
      pool,
    );
    workers.push(
      startDetectionWorker(
        redis,
        new DepositWatcher(pool, chainRouter.depositSource, ingestor, webhookOutbox),
        router.chains,
        log,
        logError,
      ),
    );

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

  const errorSink = new SqlErrorSink(sql);
  for (const worker of workers) {
    worker.on("failed", (job, err) => {
      void handleError(err, {
        sink: errorSink,
        onCritical: (record) =>
          logError("critical job failure", { job: job?.name, code: record.code, id: record.id }),
      });
    });
  }

  log("workers started", {
    count: workers.length,
    queues: [
      QUEUE_WEBHOOK_DISPATCH,
      QUEUE_EXTERNAL_RECONCILE,
      QUEUE_POOL_RELEASE,
      QUEUE_POOL_BALANCE,
      QUEUE_DEPOSIT_DETECT,
    ],
  });

  const port = Number(env["WORKER_PORT"] ?? "3001");
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok", workers: workers.length }));
  });
  server.listen(port, "0.0.0.0", () => {
    log("worker health endpoint listening", { port });
  });

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
  const { record } = resolveError(err);
  logError("worker failed to start", { code: record.code, id: record.id, error: record.message });
  process.exit(1);
});
