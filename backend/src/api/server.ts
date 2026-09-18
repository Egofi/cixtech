import { EoaFundTransferStrategy, GatherStrategyRegistry } from "@/attribution";
import { ChainRegistry, chainEnvOrNull } from "@/chain-config";
import {
  AuthorizationSigner,
  AuthorizingBroadcaster,
  BroadcasterGasFunder,
  FetchWebhookPoster,
  GasStation,
  PolicyEngine,
  TreasuryGasFloat,
} from "@/chains";
import { openDatabase } from "@/postgres";
import { LedgerService } from "@/services";
import { SqlAllowlist, SqlKillSwitch, SqlLedgerStore, SqlVelocityLimiter } from "@/stores";
import type { GasStationConfig } from "@/types";

import { buildRouter } from "@/chains";
import { buildApp } from "./app.js";

import { buildEngine } from "./engine.js";
import {
  assertCustodyModelAcknowledged,
  assertPolicyConfigured,
  resolveTrustProxy,
} from "./policy-config.js";
import { assertSchemaReady } from "./sql.js";
import { tenantScopedSql } from "./tenant-scope.js";
import { assertPublicHost } from "./webhook-url.js";

const DETECTION_INTERVAL_MS = 15_000;
const WEBHOOK_DISPATCH_INTERVAL_MS = 5_000;
const POOL_RELEASE_INTERVAL_MS = 60_000;
const DEFAULT_VELOCITY_WINDOW_MS = 24 * 60 * 60_000;

const GAS_TOP_UP_MULTIPLE = 3n;

async function main(): Promise<void> {
  const env = process.env;
  const db = openDatabase(env);

  const sql = tenantScopedSql(db.sql);
  await assertSchemaReady(sql);

  const policyConfig = assertPolicyConfigured(env);

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

  const ledgerForOracle = new LedgerService(new SqlLedgerStore(sql));
  const approvalThreshold = env["CIXTECH_APPROVAL_THRESHOLD"];
  const approvalRequired = env["CIXTECH_APPROVAL_REQUIRED"];
  const timeLockThreshold = env["CIXTECH_TIMELOCK_THRESHOLD"];
  const timeLockDelayMs = env["CIXTECH_TIMELOCK_DELAY_MS"];

  const registry = new ChainRegistry();
  const gasRules = new Map<string, bigint>();
  const gasConfigs = new Map<string, GasStationConfig>();
  const nativeAsset = new Map<string, string>();
  for (const chain of chains) {
    const { gas } = registry.chain(chain);
    gasRules.set(chain, gas.perTransferBaseUnits);
    nativeAsset.set(chain, gas.nativeAsset);

    gasConfigs.set(chain, {
      nativeAsset: gas.nativeAsset,
      floorBaseUnits: gas.perTransferBaseUnits * 10n,
    });
  }
  const treasuryIndex = env["CIXTECH_GAS_TREASURY_INDEX"];
  const treasuryAddress = env["CIXTECH_GAS_TREASURY_ADDRESS"];

  const policyKey = env["CIXTECH_POLICY_KEY"];
  const gasAuthorizer = policyKey ? new AuthorizationSigner(policyKey, "v1") : undefined;
  const gasBroadcaster = gasAuthorizer
    ? new AuthorizingBroadcaster(router.broadcaster, gasAuthorizer)
    : router.broadcaster;

  // One definition of "the gas treasury", shared by the thing that reads its
  // balance and the thing that spends it — so the health check can never be
  // answered about a different address than the one that pays.
  //
  // Per chain, because one address string cannot be two encodings: the same key
  // is a `T…` base58 address on Tron and an `0x…` address on every EVM chain.
  // A single value served whichever family it was written for and threw in the
  // address decoder for the other. `CIXTECH_GAS_TREASURY_ADDRESS` stays as the
  // fallback for a single-family deployment, matching how
  // `CIXTECH_FEE_TREASURY_ADDRESS_<CHAIN>` already works below.
  //
  // The index is shared: it is a derivation path, not an encoding, so the same
  // index is the same key on every chain.
  const gasTreasuryOf = (
    chain: string,
  ): { address: string; derivationIndex: number } | undefined => {
    const address = env[`CIXTECH_GAS_TREASURY_ADDRESS_${chain.toUpperCase()}`] ?? treasuryAddress;
    return address && treasuryIndex
      ? { address, derivationIndex: Number(treasuryIndex) }
      : undefined;
  };

  const gasFundedChains = chains.filter((c) => gasTreasuryOf(c) !== undefined);

  const gasStation = new GasStation(
    // The chain, not the ledger: nothing posts to `gas_float:{chain}` yet, so a
    // ledger-backed source would read 0 and refuse every token payout.
    new TreasuryGasFloat(router.balances, gasTreasuryOf),
    gasConfigs,
    gasFundedChains.length > 0
      ? new BroadcasterGasFunder(gasBroadcaster, router.balances, {
          nativeAssetOf: (c) => nativeAsset.get(c) ?? "",
          treasuryOf: gasTreasuryOf,
          topUpMultiple: GAS_TOP_UP_MULTIPLE,
          ...(gasAuthorizer ? { authorizer: gasAuthorizer } : {}),
        })
      : undefined,
  );

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

  const gasFunding =
    gasFundedChains.length > 0 ? `enabled on ${gasFundedChains.join(",")}` : "DISABLED";
  const notRegistered =
    skipped.length > 0
      ? ` | not registered: ${skipped.map((s) => `${s.chain} (${s.reason})`).join(", ")}`
      : "";
  const gasHint =
    gasFundedChains.length === 0
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
    const off = policyConfig.missing.join("; ");
    console.warn(`[policy] NOT CONFIGURED: ${off} — required on mainnet, switched off here`);
  }

  const engine = buildEngine({
    sql,
    chains: router,
    gatherStrategies,
    feeTreasuryAddressFor,
    ...(feeSweepDust ? { feeSweepDustBaseUnits: BigInt(feeSweepDust) } : {}),

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

    webhookPoster: new FetchWebhookPoster(async (url) => {
      await assertPublicHost(new URL(url).hostname);
    }),
    engineXpub,
    feeBasisPoints: Number(env["CIXTECH_FEE_BPS"] ?? "50"),

    ...(policyKey ? { policyKey } : {}),
  });

  const corsOrigins = (env["CIXTECH_CORS_ORIGINS"] ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);

  const trustProxy = resolveTrustProxy(env);

  const app = await buildApp(engine, {
    corsOrigins,
    ...(trustProxy !== undefined ? { trustProxy } : {}),
    ...(env["CIXTECH_ALLOW_INSECURE_WEBHOOKS"] === "true" ? { allowInsecureWebhooks: true } : {}),
    ...(env["CIXTECH_PUBLIC_METRICS"] === "true" ? { publicMetrics: true } : {}),
    cookie: {
      crossSite: env["CIXTECH_COOKIE_CROSS_SITE"] !== "false",
      secure: env["CIXTECH_COOKIE_SECURE"] !== "false",
      ...(env["CIXTECH_COOKIE_DOMAIN"] ? { domain: env["CIXTECH_COOKIE_DOMAIN"] } : {}),
    },
    session: {
      ...(env["CIXTECH_SESSION_ABSOLUTE_MS"]
        ? { absoluteMs: Number(env["CIXTECH_SESSION_ABSOLUTE_MS"]) }
        : {}),
      ...(env["CIXTECH_SESSION_IDLE_MS"] ? { idleMs: Number(env["CIXTECH_SESSION_IDLE_MS"]) } : {}),
      ...(env["CIXTECH_SESSION_MAX_FAILED_LOGINS"]
        ? { maxFailedLogins: Number(env["CIXTECH_SESSION_MAX_FAILED_LOGINS"]) }
        : {}),
      ...(env["CIXTECH_SESSION_LOCKOUT_MS"]
        ? { lockoutMs: Number(env["CIXTECH_SESSION_LOCKOUT_MS"]) }
        : {}),
    },
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
  app.log.info(
    {
      chains,
      database: db.describe,
      corsOrigins: corsOrigins.length > 0 ? corsOrigins : "none (same-origin only)",
      // Printed because it silently changes what req.ip means, and therefore
      // what the auth rate limiter counts and what the audit trail records.
      trustProxy: trustProxy ?? "off (req.ip is the socket address)",
    },
    "cixtech API listening — consoles ship separately (apps/web), scheduled work in the worker (apps/worker)",
  );

  const workerHandles = Boolean(env["REDIS_URL"]);

  if (workerHandles) {
    app.log.info(
      "REDIS_URL set — deposit detection, webhook dispatch and pool release run in the worker process",
    );
  } else {
    app.log.error(
      { chains },
      "REDIS_URL is NOT set. The worker process owns deposit detection, webhook " +
        "delivery and pool release — without it, deposits are never credited. " +
        "Falling back to in-process loops; do not run this configuration with more " +
        "than one API replica.",
    );

    const runDetection = () => {
      void engine.watcher.pollAll(chains).then((r) => {
        for (const f of r.failures) console.error("detection poll failed", f);
      });
    };
    runDetection();
    setInterval(runDetection, DETECTION_INTERVAL_MS);

    setInterval(() => {
      void engine.webhookDispatcher
        .dispatchDue()
        .catch((err) => console.error("webhook dispatch failed", err));
    }, WEBHOOK_DISPATCH_INTERVAL_MS);

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
