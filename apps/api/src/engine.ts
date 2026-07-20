import { PoolGatherer, PoolManager, PooledAttribution, SqlPoolStore } from "@cixtech/attribution";
import {
  type ChainRouter,
  DepositIngestor,
  PayoutService,
  type PolicyEngine,
} from "@cixtech/chains";
import { LedgerService, SqlLedgerStore } from "@cixtech/ledger";
import type { SqlClient } from "@cixtech/ledger";
import { DepositWatcher } from "./detection.js";
import { IdempotencyStore } from "./idempotency.js";
import { TenantStore } from "./stores.js";
import {
  WebhookDispatcher,
  WebhookEndpointStore,
  WebhookOutbox,
  type WebhookPoster,
} from "./webhooks.js";

const COOLDOWN_MS = 30 * 60_000;

/**
 * Everything the API needs to compose the engine. All chain-touching operations
 * go through the `ChainRouter` (ADR 0016), which dispatches broadcast, balance,
 * deposit-detection, and address derivation to the addressed chain's plugin —
 * tests wire a one-chain router of fakes, prod wires Tron + EVM. The engine xpub
 * is shared across secp256k1 chains; the signer matching it lives in each plugin.
 */
export interface EngineConfig {
  sql: SqlClient;
  chains: ChainRouter;
  policy: PolicyEngine;
  webhookPoster: WebhookPoster;
  engineXpub: string;
  feeBasisPoints: number;
}

export interface Engine {
  sql: SqlClient;
  chains: ChainRouter;
  tenants: TenantStore;
  ledger: LedgerService;
  pool: PoolManager;
  payouts: PayoutService;
  ingestor: DepositIngestor;
  idempotency: IdempotencyStore;
  webhookEndpoints: WebhookEndpointStore;
  webhookOutbox: WebhookOutbox;
  webhookDispatcher: WebhookDispatcher;
  watcher: DepositWatcher;
  engineXpub: string;
}

export function buildEngine(cfg: EngineConfig): Engine {
  const ledger = new LedgerService(new SqlLedgerStore(cfg.sql));
  const pool = new PoolManager(new SqlPoolStore(cfg.sql), cfg.chains.deriveAddress, {
    cooldownMs: COOLDOWN_MS,
  });
  const gatherer = new PoolGatherer(pool, cfg.chains.balances);
  const payouts = new PayoutService(ledger, cfg.policy, cfg.chains.broadcaster, gatherer);
  const ingestor = new DepositIngestor(
    ledger,
    new PooledAttribution(pool, () => cfg.feeBasisPoints),
    pool,
  );
  const webhookEndpoints = new WebhookEndpointStore(cfg.sql);
  const webhookOutbox = new WebhookOutbox(cfg.sql);
  const webhookDispatcher = new WebhookDispatcher(
    webhookOutbox,
    webhookEndpoints,
    cfg.webhookPoster,
  );
  const watcher = new DepositWatcher(pool, cfg.chains.depositSource, ingestor, webhookOutbox);

  return {
    sql: cfg.sql,
    chains: cfg.chains,
    tenants: new TenantStore(cfg.sql),
    ledger,
    pool,
    payouts,
    ingestor,
    idempotency: new IdempotencyStore(cfg.sql),
    webhookEndpoints,
    webhookOutbox,
    webhookDispatcher,
    watcher,
    engineXpub: cfg.engineXpub,
  };
}
