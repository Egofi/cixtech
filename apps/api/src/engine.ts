import {
  type AddressBalance,
  PoolGatherer,
  PoolManager,
  PooledAttribution,
  SqlPoolStore,
} from "@cixtech/attribution";
import {
  DepositIngestor,
  type PayoutBroadcaster,
  PayoutService,
  type PolicyEngine,
} from "@cixtech/chains";
import { LedgerService, SqlLedgerStore } from "@cixtech/ledger";
import type { SqlClient } from "@cixtech/ledger";
import type { DepositSource } from "./detection.js";
import { DepositWatcher } from "./detection.js";
import { IdempotencyStore } from "./idempotency.js";
import { TenantStore } from "./stores.js";
import { WebhookDeliverer, WebhookEndpointStore, type WebhookPoster } from "./webhooks.js";

const COOLDOWN_MS = 30 * 60_000;

/**
 * Everything the API needs to compose the engine. The chain-touching pieces
 * (broadcaster, balances, deriveAddress, depositSource, webhookPoster) and the
 * engine xpub are injected, so tests wire fakes and prod wires the real Tron
 * adapters — and the signer matching `engineXpub` lives inside `broadcaster`.
 */
export interface EngineConfig {
  sql: SqlClient;
  broadcaster: PayoutBroadcaster;
  balances: AddressBalance;
  policy: PolicyEngine;
  depositSource: DepositSource;
  webhookPoster: WebhookPoster;
  engineXpub: string;
  deriveAddress: (chain: string, xpub: string, index: number) => string;
  feeBasisPoints: number;
}

export interface Engine {
  tenants: TenantStore;
  ledger: LedgerService;
  pool: PoolManager;
  payouts: PayoutService;
  ingestor: DepositIngestor;
  idempotency: IdempotencyStore;
  webhooks: WebhookDeliverer;
  webhookEndpoints: WebhookEndpointStore;
  watcher: DepositWatcher;
  engineXpub: string;
}

export function buildEngine(cfg: EngineConfig): Engine {
  const ledger = new LedgerService(new SqlLedgerStore(cfg.sql));
  const pool = new PoolManager(new SqlPoolStore(cfg.sql), cfg.deriveAddress, {
    cooldownMs: COOLDOWN_MS,
  });
  const gatherer = new PoolGatherer(pool, cfg.balances);
  const payouts = new PayoutService(ledger, cfg.policy, cfg.broadcaster, gatherer);
  const ingestor = new DepositIngestor(
    ledger,
    new PooledAttribution(pool, () => cfg.feeBasisPoints),
    pool,
  );
  const webhookEndpoints = new WebhookEndpointStore(cfg.sql);
  const webhooks = new WebhookDeliverer(webhookEndpoints, cfg.webhookPoster);
  const watcher = new DepositWatcher(pool, cfg.depositSource, ingestor, webhooks);

  return {
    tenants: new TenantStore(cfg.sql),
    ledger,
    pool,
    payouts,
    ingestor,
    idempotency: new IdempotencyStore(cfg.sql),
    webhooks,
    webhookEndpoints,
    watcher,
    engineXpub: cfg.engineXpub,
  };
}
