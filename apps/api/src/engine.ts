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
import { TenantStore } from "./stores.js";

const COOLDOWN_MS = 30 * 60_000;

/**
 * Everything the API needs to compose the underlying engine. The chain-touching
 * pieces (broadcaster, balances, deriveAddress) and the engine xpub are injected,
 * so tests wire fakes and prod wires the real Tron adapters — and the signer that
 * matches `engineXpub` lives inside `broadcaster`.
 */
export interface EngineConfig {
  sql: SqlClient;
  broadcaster: PayoutBroadcaster;
  balances: AddressBalance;
  policy: PolicyEngine;
  /** Engine account xpub the address pool derives from (public). */
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
  engineXpub: string;
}

export function buildEngine(cfg: EngineConfig): Engine {
  const ledger = new LedgerService(new SqlLedgerStore(cfg.sql));
  const pool = new PoolManager(new SqlPoolStore(cfg.sql), cfg.deriveAddress, {
    cooldownMs: COOLDOWN_MS,
  });
  const gatherer = new PoolGatherer(pool, cfg.balances);
  const payouts = new PayoutService(ledger, cfg.policy, cfg.broadcaster, gatherer);
  const attribution = new PooledAttribution(pool, () => cfg.feeBasisPoints);
  const ingestor = new DepositIngestor(ledger, attribution, pool);

  return {
    tenants: new TenantStore(cfg.sql),
    ledger,
    pool,
    payouts,
    ingestor,
    engineXpub: cfg.engineXpub,
  };
}
