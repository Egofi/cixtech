import { PoolGatherer, PoolManager, PooledAttribution, SqlPoolStore } from "@cixtech/attribution";
import {
  AuthorizationSigner,
  AuthorizingBroadcaster,
  type ChainRouter,
  DepositIngestor,
  type DepositScreener,
  PayoutJournal,
  PayoutService,
  type PolicyEngine,
  SqlAllowlist,
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
  /**
   * HSM-held policy key (§7). When set, every payout mints an authorization token
   * and the broadcaster re-verifies its sighash binding before signing — so a
   * substituted transaction is refused at the last mile. Absent = no token (dev).
   */
  policyKey?: string;
  policyVersion?: string;
  /** Optional KYT/sanctions screen for inbound deposits (§14). */
  depositScreener?: DepositScreener;
  /** Cool-down applied to a tenant-added allow-list destination (§7.2). Default 24h. */
  allowlistCooldownMs?: number;
}

const DEFAULT_ALLOWLIST_COOLDOWN_MS = 24 * 60 * 60_000;

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
  allowlist: SqlAllowlist;
  allowlistCooldownMs: number;
  engineXpub: string;
}

export function buildEngine(cfg: EngineConfig): Engine {
  const ledger = new LedgerService(new SqlLedgerStore(cfg.sql));
  const pool = new PoolManager(new SqlPoolStore(cfg.sql), cfg.chains.deriveAddress, {
    cooldownMs: COOLDOWN_MS,
  });
  const gatherer = new PoolGatherer(pool, cfg.chains.balances);

  // Authorization (§7): when a policy key is set, mint a token per payout and gate
  // the broadcaster on its sighash binding — the last-mile independent re-verify.
  const authorizer = cfg.policyKey
    ? new AuthorizationSigner(cfg.policyKey, cfg.policyVersion ?? "v1")
    : undefined;
  const broadcaster = authorizer
    ? new AuthorizingBroadcaster(cfg.chains.broadcaster, authorizer)
    : cfg.chains.broadcaster;

  const payouts = new PayoutService(ledger, cfg.policy, broadcaster, gatherer, {
    // Durable intent journal: crash-recoverable, and a retry never double-broadcasts.
    journal: new PayoutJournal(cfg.sql),
    ...(authorizer ? { authorizer } : {}),
  });
  const ingestor = new DepositIngestor(
    ledger,
    new PooledAttribution(pool, () => cfg.feeBasisPoints),
    pool,
    cfg.depositScreener,
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
    allowlist: new SqlAllowlist(cfg.sql),
    allowlistCooldownMs: cfg.allowlistCooldownMs ?? DEFAULT_ALLOWLIST_COOLDOWN_MS,
    engineXpub: cfg.engineXpub,
  };
}
