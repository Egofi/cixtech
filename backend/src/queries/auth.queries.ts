import type { Db } from "@/types";
import { sql } from "kysely";

/** `last_step` is bigint; cast so the TOTP replay guard compares strings, never floats. */
const lastStepText = sql<string | null>`t.last_step::text`.as("totp_last_step");

/** principal joined to its second factor — the shape every principal read returns. */
const withTotp = (db: Db) =>
  db
    .selectFrom("principal as p")
    .leftJoin("principal_totp as t", "t.principal_id", "p.id")
    .selectAll("p");

export const principal = {
  insert: (
    db: Db,
    row: {
      id: string;
      kind: string;
      tenant_id: string | null;
      email: string;
      password_hash: string;
      role: string;
      must_change_password: boolean;
    },
  ) => db.insertInto("principal").values(row).returning("id"),

  byEmail: (db: Db, kind: string, email: string, tenantId: string | null) =>
    withTotp(db)
      .select(["t.confirmed_at as totp_confirmed", "t.secret as totp_secret", lastStepText])
      .where("p.kind", "=", kind)
      .where(sql<boolean>`lower(p.email) = lower(${email})`)
      .$if(tenantId !== null, (qb) => qb.where("p.tenant_id", "=", tenantId)),

  byId: (db: Db, id: string) =>
    withTotp(db)
      .select(["t.confirmed_at as totp_confirmed", "t.secret as totp_secret", lastStepText])
      .where("p.id", "=", id),

  /** The listing never exposes the shared secret, only whether one is confirmed. */
  list: (db: Db, kind: string, tenantId: string | null) =>
    withTotp(db)
      .select([
        "t.confirmed_at as totp_confirmed",
        sql<string | null>`NULL`.as("totp_secret"),
        sql<string | null>`NULL`.as("totp_last_step"),
      ])
      .where("p.kind", "=", kind)
      .$if(tenantId !== null, (qb) => qb.where("p.tenant_id", "=", tenantId))
      .orderBy("p.created_at", "desc"),

  activeOperatorCount: (db: Db) =>
    db
      .selectFrom("principal")
      .select(sql<string>`count(*)::text`.as("n"))
      .where("kind", "=", "operator")
      .where("status", "=", "active"),

  setStatus: (db: Db, id: string, status: "active" | "disabled") =>
    db
      .updateTable("principal")
      .set({ status, disabled_at: status === "disabled" ? new Date() : null })
      .where("id", "=", id),

  setPassword: (db: Db, id: string, passwordHash: string, mustChange: boolean) =>
    db
      .updateTable("principal")
      .set({
        password_hash: passwordHash,
        must_change_password: mustChange,
        failed_logins: 0,
        locked_until: null,
      })
      .where("id", "=", id),

  rehashPassword: (db: Db, id: string, passwordHash: string) =>
    db.updateTable("principal").set({ password_hash: passwordHash }).where("id", "=", id),

  recordFailure: (db: Db, id: string, failedLogins: number, lockedUntil: Date | null) =>
    db
      .updateTable("principal")
      .set({ failed_logins: failedLogins, locked_until: lockedUntil })
      .where("id", "=", id),

  clearFailures: (db: Db, id: string) =>
    db.updateTable("principal").set({ failed_logins: 0, locked_until: null }).where("id", "=", id),

  touchLastLogin: (db: Db, id: string) =>
    db.updateTable("principal").set({ last_login_at: new Date() }).where("id", "=", id),
};

export const principalTotp = {
  confirmedSecret: (db: Db, principalId: string) =>
    db
      .selectFrom("principal_totp")
      .select(["secret", sql<string | null>`last_step::text`.as("last_step")])
      .where("principal_id", "=", principalId)
      .where("confirmed_at", "is not", null),

  pendingSecret: (db: Db, principalId: string) =>
    db.selectFrom("principal_totp").select("secret").where("principal_id", "=", principalId),

  upsertPending: (db: Db, principalId: string, secret: string) =>
    db
      .insertInto("principal_totp")
      .values({ principal_id: principalId, secret, confirmed_at: null, last_step: null })
      .onConflict((oc) =>
        oc.column("principal_id").doUpdateSet((eb) => ({
          secret: eb.ref("excluded.secret"),
          confirmed_at: null,
          last_step: null,
        })),
      ),

  confirm: (db: Db, principalId: string, lastStep: string) =>
    db
      .updateTable("principal_totp")
      .set({ confirmed_at: new Date(), last_step: lastStep })
      .where("principal_id", "=", principalId),

  advanceStep: (db: Db, principalId: string, step: string) =>
    db
      .updateTable("principal_totp")
      .set({ last_step: step })
      .where("principal_id", "=", principalId),
};

export const recoveryCode = {
  deleteFor: (db: Db, principalId: string) =>
    db.deleteFrom("principal_recovery_code").where("principal_id", "=", principalId),

  insert: (db: Db, principalId: string, codeHash: string) =>
    db
      .insertInto("principal_recovery_code")
      .values({ principal_id: principalId, code_hash: codeHash }),

  /** Single-use: the update only matches a code that has not been spent. */
  spend: (db: Db, principalId: string, codeHash: string) =>
    db
      .updateTable("principal_recovery_code")
      .set({ used_at: new Date() })
      .where("principal_id", "=", principalId)
      .where("code_hash", "=", codeHash)
      .where("used_at", "is", null)
      .returning("code_hash"),
};

export const authSession = {
  insert: (
    db: Db,
    row: {
      id: string;
      principal_id: string;
      token_hash: string;
      csrf_token: string;
      idle_expires_at: Date;
      expires_at: Date;
      ip: string | null;
      user_agent: string | null;
    },
  ) => db.insertInto("auth_session").values(row),

  /** A live session with the principal it belongs to — the per-request lookup. */
  resolveByTokenHash: (db: Db, tokenHash: string, now: Date) =>
    db
      .selectFrom("auth_session as s")
      .innerJoin("principal as p", "p.id", "s.principal_id")
      .leftJoin("principal_totp as t", "t.principal_id", "p.id")
      .select([
        "s.id",
        "s.principal_id",
        "s.csrf_token",
        "s.created_at",
        "s.last_seen_at",
        "s.idle_expires_at",
        "s.expires_at",
        "s.ip",
        "s.user_agent",
        "p.kind as p_kind",
        "p.tenant_id as p_tenant",
        "p.email as p_email",
        "p.role as p_role",
        "p.status as p_status",
        "p.must_change_password as p_must_change",
        "t.confirmed_at as totp_confirmed",
      ])
      .where("s.token_hash", "=", tokenHash)
      .where("s.revoked_at", "is", null)
      .where("s.expires_at", ">", now)
      .where("s.idle_expires_at", ">", now)
      .where("p.status", "=", "active"),

  slide: (db: Db, id: string, lastSeenAt: Date, idleExpiresAt: Date) =>
    db
      .updateTable("auth_session")
      .set({ last_seen_at: lastSeenAt, idle_expires_at: idleExpiresAt })
      .where("id", "=", id),

  revoke: (db: Db, id: string, reason: string) =>
    db
      .updateTable("auth_session")
      .set({ revoked_at: new Date(), revoked_reason: reason })
      .where("id", "=", id)
      .where("revoked_at", "is", null)
      .returning("id"),

  revokeAllFor: (db: Db, principalId: string, reason: string) =>
    db
      .updateTable("auth_session")
      .set({ revoked_at: new Date(), revoked_reason: reason })
      .where("principal_id", "=", principalId)
      .where("revoked_at", "is", null)
      .returning("id"),

  liveFor: (db: Db, principalId: string, now: Date) =>
    db
      .selectFrom("auth_session")
      .select([
        "id",
        "created_at",
        "last_seen_at",
        "idle_expires_at",
        "expires_at",
        "ip",
        "user_agent",
      ])
      .where("principal_id", "=", principalId)
      .where("revoked_at", "is", null)
      .where("expires_at", ">", now)
      .where("idle_expires_at", ">", now)
      .orderBy("last_seen_at", "desc"),

  deleteExpired: (db: Db, before: Date) =>
    db.deleteFrom("auth_session").where("expires_at", "<", before).returning("id"),
};

export const authAttempt = {
  insert: (
    db: Db,
    row: {
      email: string | null;
      principal_id: string | null;
      kind: string;
      outcome: string;
      ip: string | null;
      user_agent: string | null;
      detail: string | null;
    },
  ) => db.insertInto("auth_attempt").values(row),

  recent: (db: Db, limit: number) =>
    db
      .selectFrom("auth_attempt")
      .select(["at", "email", "kind", "outcome", "ip", "detail"])
      .orderBy("at", "desc")
      .limit(limit),
};
