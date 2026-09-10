import type { Db } from "@/types";
import { sql } from "kysely";

/**
 * `amount` is `numeric`. node-postgres returns numeric as a string today, but the
 * cast is written out so the money path does not depend on a driver type-parser
 * staying configured that way — every read is parsed with `BigInt`.
 */
const amountText = sql<string>`amount::text`.as("amount");

const signedNet = sql<string>`SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE -amount END)::text`;

export const journalEntry = {
  insertIgnoringDuplicate: (
    db: Db,
    row: { id: string; idempotency_key: string; kind: string; occurred_at: Date },
  ) =>
    db
      .insertInto("journal_entry")
      .values(row)
      .onConflict((oc) => oc.doNothing())
      .returning("id"),

  /** Deposit-side entries that touched a tenant's accounts — the portal statement. */
  depositsForTenant: (db: Db, tenantId: string, limit: number) =>
    db
      .selectFrom("journal_entry as je")
      .select(["je.id", "je.kind", "je.occurred_at"])
      .where((eb) => eb.or([eb("je.kind", "like", "deposit%"), eb("je.kind", "like", "reverse%")]))
      .where((eb) =>
        eb(
          "je.id",
          "in",
          eb
            .selectFrom("posting as p")
            .select("p.journal_entry_id")
            .where((inner) =>
              inner.or([
                inner("p.account", "like", `merchant_available:${tenantId}:%`),
                inner("p.account", "like", `compliance_suspense:${tenantId}%`),
              ]),
            ),
        ),
      )
      .orderBy("je.occurred_at", "desc")
      .limit(limit),

  idByIdempotencyKey: (db: Db, idempotencyKey: string) =>
    db.selectFrom("journal_entry").select("id").where("idempotency_key", "=", idempotencyKey),
};

export const posting = {
  insert: (
    db: Db,
    row: {
      journal_entry_id: string;
      account: string;
      asset: string;
      amount: string;
      direction: string;
    },
  ) => db.insertInto("posting").values(row),

  forAccountAsset: (db: Db, account: string, asset: string) =>
    db
      .selectFrom("posting")
      .select(["account", "asset", amountText, "direction"])
      .where("account", "=", account)
      .where("asset", "=", asset),

  forEntry: (db: Db, entryId: string) =>
    db
      .selectFrom("posting")
      .select(["account", "asset", amountText, "direction"])
      .where("journal_entry_id", "=", entryId),

  forEntries: (db: Db, entryIds: readonly string[]) =>
    db
      .selectFrom("posting")
      .select(["journal_entry_id", "account", "asset", amountText, "direction"])
      .where("journal_entry_id", "in", entryIds)
      .orderBy("id"),

  netByAccountAsset: (db: Db) =>
    db
      .selectFrom("posting")
      .select(["account", "asset", signedNet.as("net")])
      .groupBy(["account", "asset"]),
};

export const balance = {
  forAccountAsset: (db: Db, account: string, asset: string) =>
    db
      .selectFrom("balance")
      .select(amountText)
      .where("account", "=", account)
      .where("asset", "=", asset),

  /** A tenant's merchant-available balances, keyed by the account naming convention. */
  forTenantMerchants: (db: Db, tenantId: string) =>
    db
      .selectFrom("balance")
      .select(["account", "asset", amountText])
      .where("account", "like", `merchant_available:${tenantId}:%`)
      .orderBy("account")
      .orderBy("asset"),

  /**
   * The atomic balance update. `amount = balance.amount + EXCLUDED.amount` is the
   * statement the solvency invariant rests on: it must remain one round trip and
   * must remain visibly arithmetic, so it is written out rather than assembled.
   */
  applyDelta: (db: Db, account: string, asset: string, delta: string) =>
    sql`
      INSERT INTO balance (account, asset, amount, version)
      VALUES (${account}, ${asset}, ${delta}, 1)
      ON CONFLICT (account, asset)
      DO UPDATE SET amount = balance.amount + EXCLUDED.amount,
                    version = balance.version + 1
    `.execute(db),

  /**
   * Materialised balances that disagree with the sum of their postings. The
   * comparison is the point of the query, so the join stays explicit.
   */
  driftAgainstPostings: (db: Db) =>
    sql<{ account: string; asset: string; materialized: string; from_history: string }>`
      SELECT b.account, b.asset,
             b.amount::text AS materialized,
             COALESCE(p.net, 0)::text AS from_history
      FROM balance b
      LEFT JOIN (
        SELECT account, asset,
               SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE -amount END) AS net
        FROM posting GROUP BY account, asset
      ) p ON p.account = b.account AND p.asset = b.asset
      WHERE b.amount <> COALESCE(p.net, 0)
    `.execute(db),
};
