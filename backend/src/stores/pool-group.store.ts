import type { PoolGroupEnumerator } from "@/chains";
import { kyselyFor } from "@/postgres";
import { poolAddress } from "@/queries";
import type { Db, PoolGroup, SqlClient } from "@/types";

export class SqlPoolGroupEnumerator implements PoolGroupEnumerator {
  private readonly db: Db;

  constructor(sql: SqlClient) {
    this.db = kyselyFor(sql);
  }

  async poolGroups(): Promise<PoolGroup[]> {
    const groups = await poolAddress.activeGroups(this.db).execute();

    const result: PoolGroup[] = [];
    for (const g of groups) {
      const addresses = await poolAddress
        .addressesInGroup(this.db, g.tenant, g.merchant, g.chain)
        .execute();
      result.push({ ...g, addresses: addresses.map((r) => r.address) });
    }
    return result;
  }
}
