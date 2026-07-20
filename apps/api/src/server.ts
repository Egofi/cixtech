import { PolicyEngine, SqlKillSwitch, SqlVelocityLimiter } from "@cixtech/chains";
import { PGlite } from "@electric-sql/pglite";
import { buildApp } from "./app.js";
import { buildRouter } from "./chains/build-router.js";
import { buildEngine } from "./engine.js";
import { applySchemas, pgliteClient } from "./sql.js";
import { FetchWebhookPoster } from "./webhooks.js";

const DETECTION_INTERVAL_MS = 15_000;
const WEBHOOK_DISPATCH_INTERVAL_MS = 5_000;
const DEFAULT_VELOCITY_WINDOW_MS = 24 * 60 * 60_000;

/**
 * Production bootstrap (ADR 0016): assemble the ChainRouter from env — every chain
 * with an RPC URL is wired (Tron + the EVM family) — then compose the engine and
 * listen. The DB is PGlite here (a path makes it persistent); prod points
 * SqlClient at managed Postgres (ADR 0013). The signer is a keypair signer today;
 * swapping in the MPC ThresholdSigner is a one-line change (ADR 0007/0014).
 */
async function main(): Promise<void> {
  const env = process.env;
  const db = new PGlite(env["CIXTECH_DB_PATH"]);
  await applySchemas(db);
  const sql = pgliteClient(db);

  const { router, engineXpub, chains } = buildRouter(env, sql);
  if (chains.length === 0)
    throw new Error("No chains configured (set at least one <CHAIN>_RPC_URL)");

  const allowlist = new Set((env["CIXTECH_PAYOUT_ALLOWLIST"] ?? "").split(",").filter(Boolean));
  const maxPayout = env["CIXTECH_MAX_PAYOUT"] ?? "1000000000";
  const velocityWindowMs = Number(
    env["CIXTECH_VELOCITY_WINDOW_MS"] ?? String(DEFAULT_VELOCITY_WINDOW_MS),
  );
  const velocityMax = env["CIXTECH_VELOCITY_MAX"] ?? "10000000000";

  const engine = buildEngine({
    sql,
    chains: router,
    // Durable guardrail state (survives restart, shared across nodes): kill-switch
    // and rolling velocity cap both back onto the shared SqlClient.
    policy: new PolicyEngine({
      maxPerPayoutBaseUnits: BigInt(maxPayout),
      allowlist,
      killSwitch: new SqlKillSwitch(sql),
      velocity: new SqlVelocityLimiter(sql, {
        windowMs: velocityWindowMs,
        maxTotalBaseUnits: BigInt(velocityMax),
      }),
    }),
    webhookPoster: new FetchWebhookPoster(),
    engineXpub,
    feeBasisPoints: Number(env["CIXTECH_FEE_BPS"] ?? "50"),
  });

  const app = await buildApp(engine, {
    admin: {
      token: env["CIXTECH_ADMIN_TOKEN"],
      limits: { maxPerPayout: maxPayout, velocityWindowMs, velocityMax },
    },
  });
  const port = Number(env["PORT"] ?? "3000");
  await app.listen({ port, host: "0.0.0.0" });
  app.log.info({ chains }, "cixtech engine listening");

  // Detection loop: poll every configured chain (failures isolated per chain).
  setInterval(() => {
    void engine.watcher.pollAll(chains).then((r) => {
      for (const f of r.failures) console.error("detection poll failed", f);
    });
  }, DETECTION_INTERVAL_MS);

  // Webhook dispatch loop: drain the outbox with retries + dead-lettering.
  setInterval(() => {
    void engine.webhookDispatcher
      .dispatchDue()
      .catch((err) => console.error("webhook dispatch failed", err));
  }, WEBHOOK_DISPATCH_INTERVAL_MS);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
