import {
  GatherConfigStore,
  GatherLease,
  type GatherStrategyRegistry,
  PoolGatherer,
  PoolManager,
  PooledAttribution,
} from "@/attribution";
import {
  AuthorizationSigner,
  AuthorizingBroadcaster,
  type ChainRouter,
  DepositIngestor,
  type DepositScreener,
  DepositWatcher,
  FeeSweepPlanner,
  type PayoutBroadcaster,
  PayoutJournal,
  type PolicyEngine,
  WebhookDispatcher,
  WebhookEndpointStore,
  WebhookOutbox,
  type WebhookPoster,
} from "@/chains";
import { LedgerService, PayoutService } from "@/services";
import { ApprovalStore, SqlAllowlist, SqlLedgerStore, SqlPoolStore, TenantStore } from "@/stores";
import type { SqlClient } from "@/types";

import { IdempotencyStore } from "./idempotency.js";

const COOLDOWN_MS = 30 * 60_000;

export interface EngineConfig {
  sql: SqlClient;

  feeTreasuryAddressFor?: (chain: string) => string | undefined;

  feeSweepDustBaseUnits?: bigint;
  chains: ChainRouter;
  policy: PolicyEngine;
  webhookPoster: WebhookPoster;
  engineXpub: string;
  feeBasisPoints: number;

  policyKey?: string;
  policyVersion?: string;

  depositScreener?: DepositScreener;

  allowlistCooldownMs?: number;

  gatherStrategies?: GatherStrategyRegistry;

  poolCooldownMs?: number;

  approvalsRequired?: number;
}

const DEFAULT_ALLOWLIST_COOLDOWN_MS = 24 * 60 * 60_000;

export interface Engine {
  sql: SqlClient;

  broadcaster: PayoutBroadcaster;

  authorizer: AuthorizationSigner | undefined;

  feeSweepPlanner: FeeSweepPlanner;

  gatherLease: GatherLease;
  gatherConfig: GatherConfigStore;
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

  releaseCooledAddresses(now?: Date): Promise<number>;
}

export function buildEngine(cfg: EngineConfig): Engine {
  const ledger = new LedgerService(new SqlLedgerStore(cfg.sql));
  const gatherConfig = new GatherConfigStore(cfg.sql, (chain) => cfg.chains.familyOf(chain));
  const pool = new PoolManager(new SqlPoolStore(cfg.sql), cfg.chains.deriveAddress, {
    cooldownMs: cfg.poolCooldownMs ?? COOLDOWN_MS,

    activeStrategy: (chain, tenant) => gatherConfig.activeFor(chain, tenant),
  });
  const gatherer = new PoolGatherer(pool, cfg.chains.balances);
  const gatherLease = new GatherLease(cfg.sql);
  const feeSweepPlanner = new FeeSweepPlanner(cfg.sql, pool, cfg.chains.balances, {
    ...(cfg.feeSweepDustBaseUnits !== undefined
      ? { dustThresholdBaseUnits: cfg.feeSweepDustBaseUnits }
      : {}),
  });

  const authorizer = cfg.policyKey
    ? new AuthorizationSigner(cfg.policyKey, cfg.policyVersion ?? "v1")
    : undefined;
  const broadcaster = authorizer
    ? new AuthorizingBroadcaster(cfg.chains.broadcaster, authorizer)
    : cfg.chains.broadcaster;

  const payouts = new PayoutService(ledger, cfg.policy, broadcaster, gatherer, {
    journal: new PayoutJournal(cfg.sql),

    approvals: new ApprovalStore(cfg.sql),
    ...(cfg.approvalsRequired !== undefined ? { approvalsRequired: cfg.approvalsRequired } : {}),
    ...(authorizer ? { authorizer } : {}),
    ...(cfg.gatherStrategies ? { gatherStrategies: cfg.gatherStrategies } : {}),
    ...(cfg.feeTreasuryAddressFor
      ? { feeSweep: { planner: feeSweepPlanner, treasuryAddressFor: cfg.feeTreasuryAddressFor } }
      : {}),
    gatherLease,
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
    broadcaster,
    authorizer,
    feeSweepPlanner,
    gatherLease,
    gatherConfig,
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
    releaseCooledAddresses: (now = new Date()) => pool.releaseCooled(now),
  };
}
