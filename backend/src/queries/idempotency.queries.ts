import type { Db } from "@/types";

export const idempotencyKey = {
  claim: (db: Db, tenantId: string, key: string) =>
    db
      .insertInto("idempotency_key")
      .values({ tenant_id: tenantId, key })
      .onConflict((oc) => oc.doNothing())
      .returning("key"),

  load: (db: Db, tenantId: string, key: string) =>
    db
      .selectFrom("idempotency_key")
      .select(["status", "response"])
      .where("tenant_id", "=", tenantId)
      .where("key", "=", key),

  complete: (db: Db, tenantId: string, key: string, status: number, response: string) =>
    db
      .updateTable("idempotency_key")
      .set({ status, response })
      .where("tenant_id", "=", tenantId)
      .where("key", "=", key),

  release: (db: Db, tenantId: string, key: string) =>
    db.deleteFrom("idempotency_key").where("tenant_id", "=", tenantId).where("key", "=", key),
};
