import type { PoolGroup, PoolGroupEnumerator } from "@cixtech/chains";
import type { SqlClient } from "@cixtech/ledger";

/**
 * SQL implementation of `PoolGroupEnumerator` (build spec §8, `reconcile-external`).
 *
 * Groups every non-AVAILABLE pool address by `(tenant, merchant, chain)` and
 * returns the addresses in each group. The external reconciler then compares each
 * group's on-chain balances against the ledger's `pool_addr:{chain}:{merchant}`
 * account.
 */
export class SqlPoolGroupEnumerator implements PoolGroupEnumerator {
  constructor(private readonly sql: SqlClient) {}

  async poolGroups(): Promise<PoolGroup[]> {
    // 1. Distinct groups (tenant, merchant, chain) that have addresses in use.
    const { rows: groups } = await this.sql.query<{
      tenant: string;
      merchant: string;
      chain: string;
    }>(
      `SELECT DISTINCT tenant, merchant, chain FROM pool_address
       WHERE state != 'AVAILABLE'
       ORDER BY chain, tenant, merchant`,
    );

    // 2. For each group, resolve the actual addresses.
    const result: PoolGroup[] = [];
    for (const g of groups) {
      const { rows: addresses } = await this.sql.query<{ address: string }>(
        `SELECT address FROM pool_address
         WHERE tenant = $1 AND merchant = $2 AND chain = $3`,
        [g.tenant, g.merchant, g.chain],
      );
      result.push({
        tenant: g.tenant,
        merchant: g.merchant,
        chain: g.chain,
        addresses: addresses.map((r) => r.address),
      });
    }
    return result;
  }
}
