import {
  FetchHttpClient,
  PolicyEngine,
  TronAdapter,
  TronBalanceProvider,
  TronPayoutBroadcaster,
  deriveTronAddress,
  makeTronSigner,
} from "@cixtech/chains";
import { PGlite } from "@electric-sql/pglite";
import { HDKey } from "@scure/bip32";
import { buildApp } from "./app.js";
import { buildEngine } from "./engine.js";
import { applySchemas, pgliteClient } from "./sql.js";
import { FetchWebhookPoster } from "./webhooks.js";

const TRON_SOLIDIFIED_CONFIRMATIONS = 19;
const DETECTION_INTERVAL_MS = 15_000;
const WEBHOOK_DISPATCH_INTERVAL_MS = 5_000;

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

/**
 * Production bootstrap: wire the real Tron adapters from env and listen. The DB is
 * PGlite here (a path makes it persistent); prod points SqlClient at managed
 * Postgres (ADR 0013). The engine signer is a keypair signer today; swapping in
 * the MPC ThresholdSigner is a one-line change (ADR 0007/0014).
 */
async function main(): Promise<void> {
  const env = process.env;
  const accountXprv = required("CIXTECH_ENGINE_XPRV");
  const rpc = required("TRON_RPC_URL");
  const usdt = env["TRON_USDT_ADDRESS"];
  const tokenContracts: Record<string, string> = usdt ? { USDT: usdt } : {};
  const apiKey = env["TRONGRID_API_KEY"];

  const db = new PGlite(env["CIXTECH_DB_PATH"]);
  await applySchemas(db);

  const http = new FetchHttpClient();
  const signer = makeTronSigner(accountXprv);
  const engineXpub = HDKey.fromExtendedKey(accountXprv).publicExtendedKey;
  const allowlist = new Set((env["CIXTECH_PAYOUT_ALLOWLIST"] ?? "").split(",").filter(Boolean));
  const tron = new TronAdapter(http, {
    baseUrl: rpc,
    confirmations: TRON_SOLIDIFIED_CONFIRMATIONS,
    ...(apiKey ? { apiKey } : {}),
  });

  const engine = buildEngine({
    sql: pgliteClient(db),
    broadcaster: new TronPayoutBroadcaster(http, signer, {
      baseUrl: rpc,
      tokenContracts,
      feeLimitSun: 100_000_000,
      ...(apiKey ? { apiKey } : {}),
    }),
    balances: new TronBalanceProvider(http, rpc, tokenContracts, apiKey),
    policy: new PolicyEngine({
      maxPerPayoutBaseUnits: BigInt(env["CIXTECH_MAX_PAYOUT"] ?? "1000000000"),
      allowlist,
    }),
    depositSource: { fetchInbound: (_chain, address) => tron.fetchInboundTrc20(address) },
    webhookPoster: new FetchWebhookPoster(),
    engineXpub,
    deriveAddress: (_chain, xpub, index) => deriveTronAddress(xpub, index),
    feeBasisPoints: Number(env["CIXTECH_FEE_BPS"] ?? "50"),
  });

  const app = await buildApp(engine);
  const port = Number(env["PORT"] ?? "3000");
  await app.listen({ port, host: "0.0.0.0" });

  // Detection loop: poll for confirmed deposits (enqueues webhooks to the outbox).
  setInterval(() => {
    void engine.watcher
      .pollOnce("TRON")
      .catch((err) => console.error("detection poll failed", err));
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
