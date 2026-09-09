import type { Db } from "@/types";
import { sql } from "kysely";

export const payoutIntent = {
  begin: (
    db: Db,
    row: {
      id: string;
      idempotency_key: string;
      tenant: string;
      merchant: string;
      chain: string;
      asset: string;
      amount_base_units: string;
      destination: string;
      requested_by: string | null;
    },
  ) =>
    db
      .insertInto("payout_intent")
      .values(row)
      .onConflict((oc) => oc.column("idempotency_key").doNothing()),

  byIdempotencyKey: (db: Db, key: string) =>
    db.selectFrom("payout_intent").selectAll().where("idempotency_key", "=", key),

  byIdForTenant: (db: Db, id: string, tenant: string) =>
    db.selectFrom("payout_intent").selectAll().where("id", "=", id).where("tenant", "=", tenant),

  setBroadcasting: (db: Db, key: string, fromAddress: string) =>
    db
      .updateTable("payout_intent")
      .set({ from_address: fromAddress, status: "broadcasting", updated_at: new Date() })
      .where("idempotency_key", "=", key),

  setBroadcast: (db: Db, key: string, txId: string) =>
    db
      .updateTable("payout_intent")
      .set({ tx_id: txId, status: "broadcast", updated_at: new Date() })
      .where("idempotency_key", "=", key),

  setSettled: (db: Db, key: string) =>
    db
      .updateTable("payout_intent")
      .set({ status: "settled", updated_at: new Date() })
      .where("idempotency_key", "=", key),

  setFailed: (db: Db, key: string, error: string) =>
    db
      .updateTable("payout_intent")
      .set({ status: "failed", last_error: error, updated_at: new Date() })
      .where("idempotency_key", "=", key),

  /** Intents that started moving and never finished — the stuck-payout sweep. */
  stuckSince: (db: Db, before: Date) =>
    db
      .selectFrom("payout_intent")
      .selectAll()
      .where("status", "in", ["locked", "broadcasting", "broadcast"])
      .where("updated_at", "<", before)
      .orderBy("updated_at"),

  recentFor: (db: Db, tenantId: string, limit: number) =>
    db
      .selectFrom("payout_intent")
      .select([
        "idempotency_key",
        "merchant",
        "chain",
        "asset",
        sql<string>`amount_base_units::text`.as("amount_base_units"),
        "destination",
        "status",
        "tx_id",
        "created_at",
      ])
      .where("tenant", "=", tenantId)
      .orderBy("created_at", "desc")
      .limit(limit),
};
