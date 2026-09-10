import type { Db } from "@/types";

export const tenant = {
  insert: (db: Db, id: string, name: string) => db.insertInto("tenant").values({ id, name }),

  exists: (db: Db, id: string) => db.selectFrom("tenant").select("id").where("id", "=", id),
};

export const apiKey = {
  insert: (
    db: Db,
    row: {
      key_hash: string;
      tenant_id: string;
      id: string;
      scopes: string[];
      label?: string | null;
    },
  ) => db.insertInto("api_key").values(row),

  /** Authentication: a live key joined to the tenant it belongs to. */
  authenticate: (db: Db, keyHash: string) =>
    db
      .selectFrom("api_key as k")
      .innerJoin("tenant as t", "t.id", "k.tenant_id")
      .select(["t.id", "t.name", "k.id as key_id", "k.scopes"])
      .where("k.key_hash", "=", keyHash)
      .where("k.revoked_at", "is", null),

  listFor: (db: Db, tenantId: string) =>
    db
      .selectFrom("api_key")
      .select(["id", "label", "scopes", "created_at", "revoked_at", "revoked_reason"])
      .where("tenant_id", "=", tenantId)
      .orderBy("created_at", "desc"),

  liveIdsFor: (db: Db, tenantId: string) =>
    db
      .selectFrom("api_key")
      .select("id")
      .where("tenant_id", "=", tenantId)
      .where("revoked_at", "is", null),

  revoke: (db: Db, tenantId: string, keyId: string, reason: string) =>
    db
      .updateTable("api_key")
      .set({ revoked_at: new Date(), revoked_reason: reason })
      .where("tenant_id", "=", tenantId)
      .where("id", "=", keyId)
      .where("revoked_at", "is", null)
      .returning("id"),

  revokeMany: (db: Db, keyIds: readonly string[], reason: string) =>
    db
      .updateTable("api_key")
      .set({ revoked_at: new Date(), revoked_reason: reason })
      .where("id", "in", keyIds)
      .where("revoked_at", "is", null),

  revokeById: (db: Db, keyId: string, reason: string) =>
    db
      .updateTable("api_key")
      .set({ revoked_at: new Date(), revoked_reason: reason })
      .where("id", "=", keyId)
      .where("revoked_at", "is", null)
      .returning("id"),
};

export const account = {
  insert: (db: Db, id: string, tenantId: string, externalRef: string | null) =>
    db.insertInto("account").values({ id, tenant_id: tenantId, external_ref: externalRef }),

  listFor: (db: Db, tenantId: string, limit: number) =>
    db
      .selectFrom("account")
      .select(["id", "tenant_id", "external_ref", "created_at"])
      .where("tenant_id", "=", tenantId)
      .orderBy("created_at", "desc")
      .limit(limit),

  ownedBy: (db: Db, id: string, tenantId: string) =>
    db
      .selectFrom("account")
      .select(["id", "tenant_id", "external_ref"])
      .where("id", "=", id)
      .where("tenant_id", "=", tenantId),
};
