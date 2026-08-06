import { EoaFundTransferStrategy, GatherStrategyRegistry } from "@cixtech/attribution";
import { ChainRegistry } from "@cixtech/chain-config";
import {
  BroadcasterGasFunder,
  GasStation,
  type GasStationConfig,
  PolicyEngine,
  SqlAllowlist,
  SqlKillSwitch,
  SqlVelocityLimiter,
} from "@cixtech/chains";
import { LedgerService, SqlLedgerStore } from "@cixtech/ledger";
import { buildApp } from "./app.js";
import { buildRouter } from "./chains/build-router.js";
import { openDatabase } from "./db.js";
import { buildEngine } from "./engine.js";
import { assertSchemaReady } from "./sql.js";
import { FetchWebhookPoster } from "./webhooks.js";

const DETECTION_INTERVAL_MS = 15_000;
const WEBHOOK_DISPATCH_INTERVAL_MS = 5_000;
const POOL_RELEASE_INTERVAL_MS = 60_000;
const DEFAULT_VELOCITY_WINDOW_MS = 24 * 60 * 60_000;
/** Keep a pool address funded for several payouts rather than topping up each time. */
const GAS_TOP_UP_MULTIPLE = 3n;

/**
 * Production bootstrap (ADR 0016): assemble the ChainRouter from env — every chain
 * with an RPC URL is wired (Tron + the EVM family) — then compose the engine and
 * listen. The signer is a keypair signer today; swapping in the MPC
 * ThresholdSigner is a one-line change (ADR 0007/0014).
 *
 * Database (ADR 0013): Postgres only — `DATABASE_URL` is required and the schema
 * must ALREADY be migrated. The server verifies and refuses to boot rather than
 * running DDL against a custody database as a start-up side effect.
 */
async function main(): Promise<void> {
  const env = process.env;
  const db = openDatabase(env);
  const sql = db.sql;
  await assertSchemaReady(sql);

  const { router, engineXpub, chains } = buildRouter(env, sql);
  if (chains.length === 0)
    throw new Error("No chains configured (set at least one <CHAIN>_RPC_URL)");

  const allowlist = new Set((env["CIXTECH_PAYOUT_ALLOWLIST"] ?? "").split(",").filter(Boolean));
  const maxPayout = env["CIXTECH_MAX_PAYOUT"] ?? "1000000000";
  const velocityWindowMs = Number(
    env["CIXTECH_VELOCITY_WINDOW_MS"] ?? String(DEFAULT_VELOCITY_WINDOW_MS),
  );
  const velocityMax = env["CIXTECH_VELOCITY_MAX"] ?? "10000000000";

  // Fail-closed solvency gate (§7.7): a payout is refused unless the ledger can
  // prove Σ ASSET ≥ Σ LIABILITY for the asset. Backs onto the same store.
  const ledgerForOracle = new LedgerService(new SqlLedgerStore(sql));
  const approvalThreshold = env["CIXTECH_APPROVAL_THRESHOLD"];
  const approvalRequired = env["CIXTECH_APPROVAL_REQUIRED"];
  const timeLockThreshold = env["CIXTECH_TIMELOCK_THRESHOLD"];
  const timeLockDelayMs = env["CIXTECH_TIMELOCK_DELAY_MS"];

  // Gather (ADR 0011): fund-then-transfer on plain HD EOAs is the shipped
  // strategy. `prepare` provisions native gas into the pool address before an
  // ERC-20/TRC-20 transfer — without it those payouts fail for insufficient gas,
  // because a pool address only ever receives the token.
  const registry = new ChainRegistry();
  const gasRules = new Map<string, bigint>();
  const gasConfigs = new Map<string, GasStationConfig>();
  const nativeAsset = new Map<string, string>();
  for (const chain of chains) {
    const { gas } = registry.chain(chain);
    gasRules.set(chain, gas.perTransferBaseUnits);
    nativeAsset.set(chain, gas.nativeAsset);
    // Floor: refuse to provision (and trip the breaker) once the float can no
    // longer cover a meaningful number of transfers (§6.2).
    gasConfigs.set(chain, {
      nativeAsset: gas.nativeAsset,
      floorBaseUnits: gas.perTransferBaseUnits * 10n,
    });
  }
  const treasuryIndex = env["CIXTECH_GAS_TREASURY_INDEX"];
  const treasuryAddress = env["CIXTECH_GAS_TREASURY_ADDRESS"];
  const gasStation = new GasStation(
    new LedgerService(new SqlLedgerStore(sql)),
    gasConfigs,
    treasuryAddress && treasuryIndex
      ? new BroadcasterGasFunder(router.broadcaster, router.balances, {
          nativeAssetOf: (c) => nativeAsset.get(c) ?? "",
          treasuryOf: () => ({
            address: treasuryAddress,
            derivationIndex: Number(treasuryIndex),
          }),
          topUpMultiple: GAS_TOP_UP_MULTIPLE,
        })
      : undefined,
  );
  const gatherStrategies = new GatherStrategyRegistry([
    new EoaFundTransferStrategy(router.deriveAddress, gasStation, {
      gasRequirementBaseUnits: gasRules,
      nativeAssetOf: (c) => nativeAsset.get(c),
    }),
  ]);

  const engine = buildEngine({
    sql,
    chains: router,
    gatherStrategies,
    // Durable guardrail state (survives restart, shared across nodes): kill-switch,
    // cool-down-aware allow-list, solvency gate, dual-approval, time-lock, velocity.
    policy: new PolicyEngine({
      maxPerPayoutBaseUnits: BigInt(maxPayout),
      allowlist,
      allowlistStore: new SqlAllowlist(sql),
      killSwitch: new SqlKillSwitch(sql),
      solvency: { solvent: (asset) => ledgerForOracle.isSolvent(asset) },
      ...(approvalThreshold && approvalRequired
        ? {
            approval: {
              thresholdBaseUnits: BigInt(approvalThreshold),
              required: Number(approvalRequired),
            },
          }
        : {}),
      ...(timeLockThreshold && timeLockDelayMs
        ? {
            timeLock: {
              thresholdBaseUnits: BigInt(timeLockThreshold),
              delayMs: Number(timeLockDelayMs),
            },
          }
        : {}),
      velocity: new SqlVelocityLimiter(sql, {
        windowMs: velocityWindowMs,
        maxTotalBaseUnits: BigInt(velocityMax),
      }),
    }),
    ...(approvalRequired ? { approvalsRequired: Number(approvalRequired) } : {}),
    webhookPoster: new FetchWebhookPoster(),
    engineXpub,
    feeBasisPoints: Number(env["CIXTECH_FEE_BPS"] ?? "50"),
    // HSM-held policy key: mints + verifies the per-payout authorization token (§7).
    ...(env["CIXTECH_POLICY_KEY"] ? { policyKey: env["CIXTECH_POLICY_KEY"] } : {}),
  });

  const app = await buildApp(engine, {
    admin: {
      token: env["CIXTECH_ADMIN_TOKEN"],
      limits: { maxPerPayout: maxPayout, velocityWindowMs, velocityMax },
    },
  });
  const port = Number(env["PORT"] ?? "3000");
  await app.listen({ port, host: "0.0.0.0" });
  app.log.info({ chains, database: db.describe }, "cixtech engine listening");

  // Detection loop: poll every configured chain (failures isolated per chain).
  const runDetection = () => {
    void engine.watcher.pollAll(chains).then((r) => {
      for (const f of r.failures) console.error("detection poll failed", f);
    });
  };
  runDetection();
  setInterval(runDetection, DETECTION_INTERVAL_MS);

  // Webhook dispatch and pool release are handled by the BullMQ worker process
  // (apps/worker) when REDIS_URL is configured. The API falls back to its own
  // setInterval loops when REDIS_URL is absent — backwards compatible with
  // single-process deployments and test harnesses that never start Redis.
  const workerHandles = Boolean(env["REDIS_URL"]);

  if (workerHandles) {
    app.log.info("REDIS_URL set — webhook dispatch and pool release delegated to worker process");
  } else {
    // Webhook dispatch loop: drain the outbox with retries + dead-lettering.
    setInterval(() => {
      void engine.webhookDispatcher
        .dispatchDue()
        .catch((err) => console.error("webhook dispatch failed", err));
    }, WEBHOOK_DISPATCH_INTERVAL_MS);

    // Pool cool-off sweeper (ADR 0009): COOLING → AVAILABLE once the window closes,
    // so addresses are reused and the pool stays bounded.
    setInterval(() => {
      void engine
        .releaseCooledAddresses()
        .then((n) => {
          if (n > 0) app.log.info({ released: n }, "pool addresses returned to AVAILABLE");
        })
        .catch((err) => console.error("pool release failed", err));
    }, POOL_RELEASE_INTERVAL_MS);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
