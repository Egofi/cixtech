import {
  type AddressBalance,
  POOL_SCHEMA_SQL,
  PoolGatherer,
  PoolManager,
  SqlPoolStore,
} from "@/attribution";
import type { SqlClient } from "@/ledger";
import { type TestDatabase, freshDatabase } from "@test/support/index.js";

/**
 * A gatherer whose pool holds one address (at index 0) for the merchant, funded
 * plentifully — so PayoutService.gatherSingle deterministically selects it. The
 * on-chain balance is faked; the point of these tests is the gather + flow, not
 * balance discovery.
 */
export async function fundedGatherer(
  db: TestDatabase,
  sql: SqlClient,
  opts: { tenant: string; merchant: string; chain: string; address: string },
): Promise<PoolGatherer> {
  await db.exec(POOL_SCHEMA_SQL);
  const pool = new PoolManager(new SqlPoolStore(sql), () => opts.address, { cooldownMs: 60_000 });
  await pool.assign(opts.tenant, opts.merchant, opts.chain, "seed-invoice", "xpub");
  const balances: AddressBalance = {
    async balance() {
      return 10n ** 30n;
    },
  };
  return new PoolGatherer(pool, balances);
}
