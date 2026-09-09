import { type AddressBalance, PoolGatherer, PoolManager } from "@/attribution";
import { POOL_SCHEMA_SQL } from "@/schemas/sql";
import { SqlPoolStore } from "@/stores";
import type { SqlClient } from "@/types";

import { type TestDatabase, freshDatabase } from "@test/support/index.js";

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
