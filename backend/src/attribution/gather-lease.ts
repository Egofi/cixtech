import type { SqlClient } from "@/ledger";

/**
 * Serialises everything that spends a merchant's pool addresses on one chain.
 *
 * Gathering reads live on-chain balances and then spends them, and those two
 * steps are not atomic. Two operations that overlap therefore both see the same
 * balance and both plan to spend it — the second transfer fails on chain, and a
 * payout that the ledger has already locked is left stranded. There are now
 * three things that can race: two concurrent payouts for the same merchant, a
 * payout against the console's fee collection, and a retry against the attempt
 * it is retrying.
 *
 * A lease rather than a database transaction, because the protected section
 * spans network calls — an RPC read, a gas top-up, a broadcast. Holding a
 * Postgres transaction open across those would pin a pooled connection for the
 * length of a chain round trip and turn one slow RPC into connection-pool
 * exhaustion.
 *
 * Every lease carries an expiry so a process that dies mid-gather cannot wedge a
 * merchant's payouts forever. The expiry must comfortably exceed a broadcast:
 * expiring early is worse than waiting, because it re-admits the exact race the
 * lease exists to prevent.
 */
export const GATHER_LEASE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS pool_gather_lease (
  key        text PRIMARY KEY,
  holder     text NOT NULL,
  acquired_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS pool_gather_lease_expiry ON pool_gather_lease(expires_at);
`;

/** Long enough for a gas top-up plus a broadcast on a slow chain. */
const DEFAULT_TTL_MS = 120_000;

export class GatherLease {
  constructor(
    private readonly sql: SqlClient,
    private readonly ttlMs: number = DEFAULT_TTL_MS,
  ) {}

  private static key(tenant: string, merchant: string, chain: string): string {
    return `${tenant}:${merchant}:${chain.toUpperCase()}`;
  }

  /**
   * Take the lease, or return false if someone else holds a live one.
   *
   * The insert and the expiry takeover are one statement so two callers cannot
   * both conclude the lease is free — `ON CONFLICT … WHERE expires_at < now()`
   * is evaluated under the row lock the conflict takes.
   */
  async acquire(
    tenant: string,
    merchant: string,
    chain: string,
    holder: string,
    now: Date = new Date(),
  ): Promise<boolean> {
    const expires = new Date(now.getTime() + this.ttlMs);
    const { rows } = await this.sql.query<{ key: string }>(
      `INSERT INTO pool_gather_lease (key, holder, acquired_at, expires_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (key) DO UPDATE
         SET holder = EXCLUDED.holder,
             acquired_at = EXCLUDED.acquired_at,
             expires_at = EXCLUDED.expires_at
         WHERE pool_gather_lease.expires_at < $3
       RETURNING key`,
      [GatherLease.key(tenant, merchant, chain), holder, now.toISOString(), expires.toISOString()],
    );
    return rows.length > 0;
  }

  /** Release only if still ours — a lease that already expired and was taken over stays with its new holder. */
  async release(tenant: string, merchant: string, chain: string, holder: string): Promise<void> {
    await this.sql.query("DELETE FROM pool_gather_lease WHERE key = $1 AND holder = $2", [
      GatherLease.key(tenant, merchant, chain),
      holder,
    ]);
  }

  /** Run `fn` under the lease, releasing it however `fn` ends. */
  async withLease<T>(
    tenant: string,
    merchant: string,
    chain: string,
    holder: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const got = await this.acquire(tenant, merchant, chain, holder);
    if (!got) {
      throw new GatherBusyError(
        `Another operation is already spending ${merchant}'s ${chain} pool addresses. Retry shortly.`,
      );
    }
    try {
      return await fn();
    } finally {
      await this.release(tenant, merchant, chain, holder);
    }
  }
}

/** The merchant's pool is being spent by something else right now. Retryable. */
export class GatherBusyError extends Error {
  readonly code = "GATHER_BUSY";
}
