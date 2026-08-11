import {
  GatherConfigStore,
  type GatherStrategyRegistry,
  PoolGatherer,
  PoolManager,
  PooledAttribution,
  SqlPoolStore,
} from "@cixtech/attribution";
import {
  ApprovalStore,
  AuthorizationSigner,
  AuthorizingBroadcaster,
  type ChainRouter,
  DepositIngestor,
  type DepositScreener,
  FeeSweepPlanner,
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
  /**
   * Where the platform's accrued fee is collected to, per chain. Supplying it
   * turns on fee collection during the gather (§6.3) — the payout already sends
   * from these addresses, so the fee rides along instead of paying for its own.
   * Absent = payouts behave exactly as before and the fee stays accrued.
   */
  feeTreasuryAddressFor?: (chain: string) => string | undefined;
  /** Below this, a residual is left where it is rather than spending gas to move it. */
  feeSweepDustBaseUnits?: bigint;
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
  /**
   * Gather strategies (ADR 0011). New addresses mint under the configured toggle;
   * every payout leg is prepared by the strategy ITS address was minted under —
   * which is what provisions native gas before an ERC-20/TRC-20 transfer.
   */
  gatherStrategies?: GatherStrategyRegistry;
  /** How long an address cools off before returning to the pool (ADR 0009). */
  poolCooldownMs?: number;
  /** Distinct approvals a held payout needs (§7.4). Mirrors the policy config. */
  approvalsRequired?: number;
}

const DEFAULT_ALLOWLIST_COOLDOWN_MS = 24 * 60 * 60_000;

export interface Engine {
  sql: SqlClient;
  /** Decides what the platform is owed and which addresses can settle it. */
  feeSweepPlanner: FeeSweepPlanner;
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
  /**
   * Return every address whose cool-off has elapsed to the pool (ADR 0009).
   * Without this running on a timer the lifecycle stalls at COOLING, every
   * assignment mints a fresh index, and the pool — whose whole job is to BOUND
   * payout gather cost — grows without limit.
   */
  releaseCooledAddresses(now?: Date): Promise<number>;
}

export function buildEngine(cfg: EngineConfig): Engine {
  const ledger = new LedgerService(new SqlLedgerStore(cfg.sql));
  const gatherConfig = new GatherConfigStore(cfg.sql, (chain) => cfg.chains.familyOf(chain));
  const pool = new PoolManager(new SqlPoolStore(cfg.sql), cfg.chains.deriveAddress, {
    cooldownMs: cfg.poolCooldownMs ?? COOLDOWN_MS,
    // Resolved once per mint and stored on the address; draining reads the stored
    // tag, never this toggle (ADR 0011).
    activeStrategy: (chain, tenant) => gatherConfig.activeFor(chain, tenant),
  });
  const gatherer = new PoolGatherer(pool, cfg.chains.balances);
  const feeSweepPlanner = new FeeSweepPlanner(cfg.sql, pool, cfg.chains.balances, {
    ...(cfg.feeSweepDustBaseUnits !== undefined
      ? { dustThresholdBaseUnits: cfg.feeSweepDustBaseUnits }
      : {}),
  });

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
    // Durable approvals so a held payout survives a restart and can be signed off
    // by a different credential later (§7.4).
    approvals: new ApprovalStore(cfg.sql),
    ...(cfg.approvalsRequired !== undefined ? { approvalsRequired: cfg.approvalsRequired } : {}),
    ...(authorizer ? { authorizer } : {}),
    ...(cfg.gatherStrategies ? { gatherStrategies: cfg.gatherStrategies } : {}),
    ...(cfg.feeTreasuryAddressFor
      ? { feeSweep: { planner: feeSweepPlanner, treasuryAddressFor: cfg.feeTreasuryAddressFor } }
      : {}),
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
    feeSweepPlanner,
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
