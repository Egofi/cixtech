import type { Db } from "@/types";
import { sql } from "kysely";

export const errorLog = {
  capture: (
    db: Db,
    row: { id: string; code: string; message: string; context: string; at: Date },
  ) =>
    db
      .insertInto("error_log")
      .values(row)
      .onConflict((oc) => oc.column("id").doNothing()),
};

export const depositCursor = {
  nextBlock: (db: Db, chain: string, address: string) =>
    db
      .selectFrom("deposit_cursor")
      .select("next_block")
      .where("chain", "=", chain)
      .where("address", "=", address),

  advance: (db: Db, chain: string, address: string, nextBlock: string) =>
    db
      .insertInto("deposit_cursor")
      .values({ chain, address, next_block: nextBlock, updated_at: new Date() })
      .onConflict((oc) =>
        oc.columns(["chain", "address"]).doUpdateSet((eb) => ({
          next_block: eb.ref("excluded.next_block"),
          updated_at: eb.ref("excluded.updated_at"),
        })),
      ),
};

export const gatherLease = {
  /**
   * Takes the lease only if the incumbent has expired. The `WHERE` on the conflict
   * branch is the whole mechanism — without it an upsert would steal a live lease,
   * and two workers would gather the same pool at once.
   */
  acquire: (db: Db, key: string, holder: string, now: Date, expires: Date) =>
    sql<{ key: string }>`
      INSERT INTO pool_gather_lease (key, holder, acquired_at, expires_at)
      VALUES (${key}, ${holder}, ${now}, ${expires})
      ON CONFLICT (key) DO UPDATE
        SET holder = EXCLUDED.holder,
            acquired_at = EXCLUDED.acquired_at,
            expires_at = EXCLUDED.expires_at
        WHERE pool_gather_lease.expires_at < ${now}
      RETURNING key
    `.execute(db),

  release: (db: Db, key: string, holder: string) =>
    db.deleteFrom("pool_gather_lease").where("key", "=", key).where("holder", "=", holder),
};

export const sweepBalances = {
  /** Pool and merchant-liability balances for one asset, used to size a sweep. */
  forClaim: (db: Db, asset: string, merchant: string, tenant: string) =>
    db
      .selectFrom("balance")
      .select(["account", "amount"])
      .where("asset", "=", asset)
      .where((eb) =>
        eb.or([
          eb("account", "like", sql<string>`'pool_addr:%:' || ${merchant}`),
          eb("account", "like", sql<string>`'merchant\\_%:' || ${tenant} || ':' || ${merchant}`),
        ]),
      ),
};

export const anomalyInputs = {
  allowlistAddedSince: (db: Db, tenant: string, since: Date) =>
    db
      .selectFrom("payout_allowlist")
      .select(["address", "added_at"])
      .where("tenant", "=", tenant)
      .where("added_at", ">", since),
};
