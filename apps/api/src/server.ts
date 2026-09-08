import { EoaFundTransferStrategy, GatherStrategyRegistry } from "@cixtech/attribution";
import { ChainRegistry, chainEnvOrNull } from "@cixtech/chain-config";
import {
  AuthorizationSigner,
  AuthorizingBroadcaster,
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
import { assertCustodyModelAcknowledged, assertPolicyConfigured } from "./policy-config.js";
import { assertSchemaReady } from "./sql.js";
import { tenantScopedSql } from "./tenant-scope.js";
import { assertPublicHost } from "./webhook-url.js";
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
  // Every statement the engine issues inside an authenticated request binds the
  // RLS tenant GUC (§13); statements outside one — admin plane, detection loop,
  // webhook dispatcher — are untouched and stay cross-tenant. See tenant-scope.ts.
  const sql = tenantScopedSql(db.sql);
  await assertSchemaReady(sql);

  // Money-out guardrails (§7): fatal on mainnet when anything is missing, loud on
  // testnet. Checked BEFORE any chain is wired, so a misconfigured production
  // deployment never gets as far as holding a key.
  const policyConfig = assertPolicyConfigured(env);
  // The signing key lives in THIS process (ADR 0007 launch path). On mainnet that
  // has to be acknowledged explicitly rather than happening by default.
  const custody = assertCustodyModelAcknowledged(env);

  const { router, engineXpub, chains, skipped } = buildRouter(env, sql);
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

  /**
   * Authorization for engine-originated transfers (§7).
   *
   * The gas station is assembled before `buildEngine` — the gather strategies need
   * it — so it cannot read `engine.broadcaster`. It builds its own wrapper over
   * the same policy key instead: `AuthorizationSigner` is a stateless HMAC, so a
   * second instance over the same key mints and verifies identically.
   *
   * The important part is that it is the AUTHORIZING broadcaster either way. A gas
   * top-up spends engine funds on chain, and it used to take the raw router —
   * which meant an internal transfer had none of the checks a tenant payout does.
   */
  const policyKey = env["CIXTECH_POLICY_KEY"];
  const gasAuthorizer = policyKey ? new AuthorizationSigner(policyKey, "v1") : undefined;
  const gasBroadcaster = gasAuthorizer
    ? new AuthorizingBroadcaster(router.broadcaster, gasAuthorizer)
    : router.broadcaster;

  const gasStation = new GasStation(
    new LedgerService(new SqlLedgerStore(sql)),
    gasConfigs,
    treasuryAddress && treasuryIndex
      ? new BroadcasterGasFunder(gasBroadcaster, router.balances, {
          nativeAssetOf: (c) => nativeAsset.get(c) ?? "",
          treasuryOf: () => ({
            address: treasuryAddress,
            derivationIndex: Number(treasuryIndex),
          }),
          topUpMultiple: GAS_TOP_UP_MULTIPLE,
          ...(gasAuthorizer ? { authorizer: gasAuthorizer } : {}),
        })
      : undefined,
  );
  /**
   * Where the platform's accrued fee is collected to, per chain.
   *
   * Per chain and not one global address, because a sweep is a real transfer on
   * that chain — an EVM address cannot receive a TRC-20. Absent for a chain means
   * no fee is collected there; the claim simply stays accrued, which is safe.
   * Falls back to the gas treasury only when explicitly told to, since sharing
   * one address for float and revenue is a decision, not a default.
   */
  const feeTreasuryAddressFor = (chain: string): string | undefined =>
    env[`CIXTECH_FEE_TREASURY_ADDRESS_${chain.toUpperCase()}`] ??
    (env["CIXTECH_FEE_TREASURY_USES_GAS_TREASURY"] === "true" ? treasuryAddress : undefined);

  const feeSweepDust = env["CIXTECH_FEE_SWEEP_MIN_BASE_UNITS"];

  const gatherStrategies = new GatherStrategyRegistry([
    new EoaFundTransferStrategy(router.deriveAddress, gasStation, {
      gasRequirementBaseUnits: gasRules,
      nativeAssetOf: (c) => nativeAsset.get(c),
    }),
  ]);

  /**
   * Say which chains are live, which are not, and why — at boot, in the log.
   *
   * "Which chains do we support?" was previously unanswerable without reading
   * the environment of a running process, because a chain registers only when
   * its RPC URL happens to be set. Silence is the worst possible answer to that
   * question for a custody engine.
   *
   * Gas funding gets the same treatment for a related reason: without a
   * treasury, a token payout builds and signs correctly and then fails at
   * broadcast for want of native gas. That is recoverable, so it does not stop
   * boot — but it must not be discovered from a failed payout either.
   */
  const gasFunding = treasuryAddress && treasuryIndex ? "enabled" : "DISABLED";
  const notRegistered =
    skipped.length > 0
      ? ` | not registered: ${skipped.map((s) => `${s.chain} (${s.reason})`).join(", ")}`
      : "";
  const gasHint =
    gasFunding === "DISABLED"
      ? " — set CIXTECH_GAS_TREASURY_ADDRESS and _INDEX, or token payouts will fail at broadcast"
      : "";
  console.log(
    `[chains] env=${chainEnvOrNull() ?? "unset"} live=${chains.join(",") || "none"}` +
      `${notRegistered} | gas funding: ${gasFunding}${gasHint}`,
  );
  const ack = custody.acknowledged ? " — explicitly acknowledged" : "";
  const mpcNote = "Threshold MPC is implemented in packages/mpc but is NOT wired into this path.";
  console.log(
    `[custody] signing model: HOT KEY in-process (CIXTECH_ENGINE_XPRV)${ack}. ${mpcNote}`,
  );
  if (policyConfig.missing.length > 0) {
    // Reached only on a non-mainnet deployment — assertPolicyConfigured throws
    // otherwise. Still says it out loud: a control that is off must never be
    // discovered from a payout that should have been held.
    const off = policyConfig.missing.join("; ");
    console.warn(`[policy] NOT CONFIGURED: ${off} — required on mainnet, switched off here`);
  }

  const engine = buildEngine({
    sql,
    chains: router,
    gatherStrategies,
    feeTreasuryAddressFor,
    ...(feeSweepDust ? { feeSweepDustBaseUnits: BigInt(feeSweepDust) } : {}),
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
    // Re-checks the destination against DNS immediately before each delivery, so a
    // host that has since started resolving to a private address is refused.
    webhookPoster: new FetchWebhookPoster(async (url) => {
      await assertPublicHost(new URL(url).hostname);
    }),
    engineXpub,
    feeBasisPoints: Number(env["CIXTECH_FEE_BPS"] ?? "50"),
    // HSM-held policy key: mints + verifies the per-payout authorization token (§7).
    ...(policyKey ? { policyKey } : {}),
  });

  const app = await buildApp(engine, {
    ...(env["CIXTECH_ALLOW_INSECURE_WEBHOOKS"] === "true" ? { allowInsecureWebhooks: true } : {}),
    ...(env["CIXTECH_PUBLIC_METRICS"] === "true" ? { publicMetrics: true } : {}),
    rateLimit: {
      ...(env["CIXTECH_RATE_LIMIT_MAX"] ? { max: Number(env["CIXTECH_RATE_LIMIT_MAX"]) } : {}),
      ...(env["CIXTECH_RATE_LIMIT_WINDOW_MS"]
        ? { windowMs: Number(env["CIXTECH_RATE_LIMIT_WINDOW_MS"]) }
        : {}),
      ...(env["CIXTECH_RATE_LIMIT_AUTH_FAILURE_MAX"]
        ? { authFailureMax: Number(env["CIXTECH_RATE_LIMIT_AUTH_FAILURE_MAX"]) }
        : {}),
    },
    admin: {
      token: env["CIXTECH_ADMIN_TOKEN"],
      limits: { maxPerPayout: maxPayout, velocityWindowMs, velocityMax },
      feeTreasuryAddressFor,
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
