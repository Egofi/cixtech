import type { Db } from "@/types";
import { sql } from "kysely";

export const killSwitch = {
  isEngaged: (db: Db, scope: string) =>
    db.selectFrom("policy_kill_switch").select("engaged").where("scope", "=", scope),

  set: (db: Db, scope: string, engaged: boolean, reason: string | null) =>
    db
      .insertInto("policy_kill_switch")
      .values({ scope, engaged, reason, updated_at: new Date() })
      .onConflict((oc) =>
        oc.column("scope").doUpdateSet((eb) => ({
          engaged: eb.ref("excluded.engaged"),
          reason: eb.ref("excluded.reason"),
          updated_at: eb.ref("excluded.updated_at"),
        })),
      ),
};

export const payoutLog = {
  /**
   * Serialises the velocity check for one tenant/merchant/asset. The window is
   * read, compared and written inside a single transaction, so the lock is what
   * stops two concurrent payouts each seeing the pre-spend total.
   */
  lockWindow: (db: Db, advisoryKey: string) =>
    sql`SELECT pg_advisory_xact_lock(${advisoryKey}::bigint)`.execute(db),

  spentSince: (db: Db, tenant: string, merchant: string, asset: string, since: Date) =>
    db
      .selectFrom("policy_payout_log")
      .select(sql<string>`COALESCE(SUM(amount_base_units), 0)::text`.as("spent"))
      .where("tenant", "=", tenant)
      .where("merchant", "=", merchant)
      .where("asset", "=", asset)
      .where("at", ">=", since),

  record: (
    db: Db,
    row: { tenant: string; merchant: string; asset: string; amount_base_units: string; at: Date },
  ) => db.insertInto("policy_payout_log").values(row),

  prune: (db: Db, tenant: string, merchant: string, asset: string, before: Date) =>
    db
      .deleteFrom("policy_payout_log")
      .where("tenant", "=", tenant)
      .where("merchant", "=", merchant)
      .where("asset", "=", asset)
      .where("at", "<", before),
};

export const allowlist = {
  /**
   * Adding an address that is already listed must NOT restart its cool-down — the
   * conflict branch deliberately re-writes the existing `usable_at` rather than
   * the incoming one.
   */
  add: (
    db: Db,
    row: {
      tenant: string;
      merchant: string;
      chain: string;
      address: string;
      usable_at: Date;
      added_at: Date;
    },
  ) =>
    db
      .insertInto("payout_allowlist")
      .values(row)
      .onConflict((oc) =>
        oc
          .columns(["tenant", "merchant", "chain", "address"])
          .doUpdateSet({ usable_at: sql`payout_allowlist.usable_at` }),
      )
      .returning("usable_at"),

  remove: (db: Db, tenant: string, merchant: string, chain: string, address: string) =>
    db
      .deleteFrom("payout_allowlist")
      .where("tenant", "=", tenant)
      .where("merchant", "=", merchant)
      .where("chain", "=", chain)
      .where("address", "=", address)
      .returning("address"),

  usableAt: (db: Db, tenant: string, merchant: string, chain: string, address: string) =>
    db
      .selectFrom("payout_allowlist")
      .select("usable_at")
      .where("tenant", "=", tenant)
      .where("merchant", "=", merchant)
      .where("chain", "=", chain)
      .where("address", "=", address),

  listFor: (db: Db, tenant: string, limit: number) =>
    db
      .selectFrom("payout_allowlist")
      .select(["merchant", "chain", "address", "usable_at", "added_at"])
      .where("tenant", "=", tenant)
      .orderBy("added_at", "desc")
      .limit(limit),
};
