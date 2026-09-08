import type { SqlClient } from "@/ledger";
import type { AddressBalance } from "./pool-gatherer.js";

/**
 * Cached on-chain balances for pool addresses.
 *
 * The admin console needs a balance beside every pool address, and reading them
 * live is not viable: it is one RPC round trip per address per page load, the
 * pool is unbounded, and public endpoints rate-limit a handful of sequential
 * calls. So a worker observes them on an interval and the console renders from
 * here.
 *
 * A cached number is only honest if its age travels with it, which is why
 * `observed_at` is not nullable and `last_error` is recorded rather than
 * swallowed: a row that failed to refresh must be able to say so instead of
 * quietly ageing while looking current.
 *
 * This is a CACHE, never a source of truth. Money decisions — the gather, the
 * reconciler — read the chain directly. Nothing here is allowed to authorize a
 * transfer.
 */
export const BALANCE_CACHE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS pool_address_balance (
  chain             text NOT NULL,
  address           text NOT NULL,
  asset             text NOT NULL,
  balance_base_units numeric(78,0) NOT NULL DEFAULT 0,
  observed_at       timestamptz NOT NULL DEFAULT now(),
  source            text NOT NULL DEFAULT 'worker',
  last_error        text,
  PRIMARY KEY (chain, address, asset)
);
CREATE INDEX IF NOT EXISTS pool_address_balance_stale
  ON pool_address_balance(observed_at);
CREATE INDEX IF NOT EXISTS pool_address_balance_funded
  ON pool_address_balance(chain, asset)
  WHERE balance_base_units > 0;
`;

export interface CachedBalance {
  chain: string;
  address: string;
  asset: string;
  balanceBaseUnits: bigint;
  observedAt: Date;
  source: string;
  lastError: string | null;
}

/** One address+asset to observe. */
export interface BalanceTarget {
  chain: string;
  address: string;
  asset: string;
}

export interface RefreshSummary {
  observed: number;
  failed: number;
}

export class PoolBalanceCache {
  constructor(private readonly sql: SqlClient) {}

  /**
   * Every pool address paired with each asset its chain carries. Includes
   * AVAILABLE addresses deliberately: an address returns to the pool while its
   * funds are still sitting in it, so excluding them would hide real float.
   */
  async targets(assetsForChain: (chain: string) => readonly string[]): Promise<BalanceTarget[]> {
    const { rows } = await this.sql.query<{ chain: string; address: string }>(
      "SELECT chain, address FROM pool_address ORDER BY chain, derivation_index",
    );
    const out: BalanceTarget[] = [];
    for (const r of rows) {
      for (const asset of assetsForChain(r.chain)) {
        out.push({ chain: r.chain, address: r.address, asset });
      }
    }
    return out;
  }

  async record(
    target: BalanceTarget,
    balance: bigint,
    source: string,
    at: Date = new Date(),
  ): Promise<void> {
    await this.sql.query(
      `INSERT INTO pool_address_balance
         (chain, address, asset, balance_base_units, observed_at, source, last_error)
       VALUES ($1, $2, $3, $4, $5, $6, NULL)
       ON CONFLICT (chain, address, asset) DO UPDATE SET
         balance_base_units = EXCLUDED.balance_base_units,
         observed_at        = EXCLUDED.observed_at,
         source             = EXCLUDED.source,
         last_error         = NULL`,
      [target.chain, target.address, target.asset, balance.toString(), at.toISOString(), source],
    );
  }

  /**
   * Record a failed observation WITHOUT touching the balance or its timestamp.
   * The previous number stays, visibly ageing, with the reason attached — which
   * is more useful than either deleting it or refreshing its age on a read that
   * never happened.
   */
  async recordFailure(target: BalanceTarget, error: string): Promise<void> {
    await this.sql.query(
      `INSERT INTO pool_address_balance
         (chain, address, asset, balance_base_units, observed_at, source, last_error)
       VALUES ($1, $2, $3, 0, now(), 'worker', $4)
       ON CONFLICT (chain, address, asset) DO UPDATE SET last_error = EXCLUDED.last_error`,
      [target.chain, target.address, target.asset, error.slice(0, 500)],
    );
  }

  /**
   * Observe every target and store the result. Failures are isolated per target
   * so one unreachable chain cannot stop the rest of the sweep, and are counted
   * rather than thrown.
   */
  async refresh(
    targets: BalanceTarget[],
    balances: AddressBalance,
    opts: { concurrency?: number; source?: string } = {},
  ): Promise<RefreshSummary> {
    const concurrency = Math.max(1, opts.concurrency ?? 4);
    const source = opts.source ?? "worker";
    let observed = 0;
    let failed = 0;
    let cursor = 0;

    const runOne = async (): Promise<void> => {
      while (cursor < targets.length) {
        const target = targets[cursor++] as BalanceTarget;
        try {
          const value = await balances.balance(target.chain, target.address, target.asset);
          await this.record(target, value, source);
          observed++;
        } catch (err) {
          await this.recordFailure(target, err instanceof Error ? err.message : String(err));
          failed++;
        }
      }
    };

    await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, runOne));
    return { observed, failed };
  }
}
