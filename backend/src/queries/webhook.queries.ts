import type { Db } from "@/types";
import { sql } from "kysely";

export const webhookEndpoint = {
  upsert: (db: Db, tenantId: string, url: string, secret: string) =>
    db
      .insertInto("webhook_endpoint")
      .values({ tenant_id: tenantId, url, secret })
      .onConflict((oc) =>
        oc.column("tenant_id").doUpdateSet((eb) => ({
          url: eb.ref("excluded.url"),
          secret: eb.ref("excluded.secret"),
        })),
      ),

  withSecretFor: (db: Db, tenantId: string) =>
    db.selectFrom("webhook_endpoint").select(["url", "secret"]).where("tenant_id", "=", tenantId),

  urlFor: (db: Db, tenantId: string) =>
    db.selectFrom("webhook_endpoint").select("url").where("tenant_id", "=", tenantId),
};

export const webhookDelivery = {
  enqueue: (db: Db, row: { id: string; tenant_id: string; body: string; next_attempt: Date }) =>
    db.insertInto("webhook_delivery").values(row),

  /**
   * Claims a batch of due deliveries. `FOR UPDATE SKIP LOCKED` is what lets many
   * workers drain the same queue without ever handing the same delivery to two of
   * them, so the lock is written out rather than assembled.
   */
  claimDue: (db: Db, now: Date, limit: number) =>
    sql<{ id: string; tenant_id: string; body: string; attempts: number }>`
      SELECT id, tenant_id, body, attempts FROM webhook_delivery
      WHERE status = 'pending' AND next_attempt <= ${now}
      ORDER BY next_attempt LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    `.execute(db),

  extendLease: (db: Db, ids: readonly string[], until: Date) =>
    db.updateTable("webhook_delivery").set({ next_attempt: until }).where("id", "in", ids),

  markDelivered: (db: Db, id: string) =>
    db.updateTable("webhook_delivery").set({ status: "delivered" }).where("id", "=", id),

  recordFailure: (
    db: Db,
    id: string,
    attempts: number,
    nextAttempt: Date,
    error: string,
    dead: boolean,
  ) =>
    db
      .updateTable("webhook_delivery")
      .set({
        attempts,
        next_attempt: nextAttempt,
        last_error: error,
        status: dead ? "dead" : "pending",
      })
      .where("id", "=", id),

  recentFor: (db: Db, tenantId: string, limit: number) =>
    db
      .selectFrom("webhook_delivery")
      .select(["id", "body", "status", "attempts", "last_error", "created_at"])
      .where("tenant_id", "=", tenantId)
      .orderBy("created_at", "desc")
      .limit(limit),
};
