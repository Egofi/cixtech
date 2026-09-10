import { randomUUID } from "node:crypto";
import { AccountLockedError, AuthError, PrincipalExistsError } from "@/common";
import { kyselyFor } from "@/postgres";
import {
  authAttempt,
  authSession,
  principal as principalQ,
  principalTotp,
  recoveryCode,
} from "@/queries";
import type { Db, PrincipalKind, Session, SessionConfig, SqlClient } from "@/types";

import {
  generateRecoveryCodes,
  generateTotpSecret,
  hashPassword,
  hashToken,
  needsRehash,
  randomToken,
  verifyPassword,
  verifyTotp,
} from "@/auth/crypto.js";
import { type Role, parseRole, requiresTotp } from "@/auth/roles.js";

export interface Principal {
  id: string;
  kind: PrincipalKind;
  tenantId: string | null;
  email: string;
  role: Role;
  status: "active" | "disabled";
  mustChangePassword: boolean;
  totpConfirmed: boolean;
}

export const DEFAULT_SESSION_CONFIG: SessionConfig = {
  absoluteMs: 12 * 60 * 60_000, // a working day
  idleMs: 30 * 60_000,
  maxFailedLogins: 5,
  lockoutMs: 15 * 60_000,
};

interface PrincipalRow {
  id: string;
  kind: PrincipalKind;
  tenant_id: string | null;
  email: string;
  password_hash: string;
  role: string;
  status: "active" | "disabled";
  must_change_password: boolean;
  failed_logins: number;
  locked_until: string | null;
  totp_confirmed: string | null;
  totp_secret: string | null;
  totp_last_step: string | null;
}

const toPrincipal = (r: PrincipalRow): Principal => ({
  id: r.id,
  kind: r.kind,
  tenantId: r.tenant_id,
  email: r.email,
  role: r.role as Role,
  status: r.status,
  mustChangePassword: r.must_change_password,
  totpConfirmed: r.totp_confirmed != null,
});

export class AuthStore {
  private readonly db: Db;

  constructor(
    private readonly sql: SqlClient,
    private readonly config: SessionConfig = DEFAULT_SESSION_CONFIG,
  ) {
    this.db = kyselyFor(sql);
  }

  async createPrincipal(input: {
    kind: PrincipalKind;
    tenantId?: string | null;
    email: string;
    password: string;
    role: string;
    mustChangePassword?: boolean;
  }): Promise<Principal> {
    const role = parseRole(input.kind, input.role);
    const email = input.email.trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      throw new AuthError(`${JSON.stringify(email)} is not a valid email address`, {
        exposable: true,
      });
    }
    const id = randomUUID();
    const hash = await hashPassword(input.password);
    try {
      await principalQ
        .insert(this.db, {
          id,
          kind: input.kind,
          tenant_id: input.tenantId ?? null,
          email,
          password_hash: hash,
          role,
          must_change_password: input.mustChangePassword ?? false,
        })
        .execute();
    } catch (err) {
      if (
        String(err).includes("principal_operator_email") ||
        String(err).includes("principal_tenant_email")
      ) {
        throw new PrincipalExistsError(`An account already exists for ${email}`, {
          exposable: true,
        });
      }
      throw err;
    }
    return {
      id,
      kind: input.kind,
      tenantId: input.tenantId ?? null,
      email,
      role,
      status: "active",
      mustChangePassword: input.mustChangePassword ?? false,
      totpConfirmed: false,
    };
  }

  private async loadByEmail(
    kind: PrincipalKind,
    email: string,
    tenantId?: string | null,
  ): Promise<PrincipalRow | null> {
    const row = await principalQ.byEmail(this.db, kind, email, tenantId ?? null).executeTakeFirst();
    return (row as PrincipalRow | undefined) ?? null;
  }

  async loadById(id: string): Promise<Principal | null> {
    const row = await principalQ.byId(this.db, id).executeTakeFirst();
    return row ? toPrincipal(row as PrincipalRow) : null;
  }

  async operatorCount(): Promise<number> {
    const row = await principalQ.activeOperatorCount(this.db).executeTakeFirst();
    return Number(row?.n ?? 0);
  }

  async listPrincipals(
    kind: PrincipalKind,
    tenantId?: string | null,
  ): Promise<Array<Principal & { createdAt: string; lastLoginAt: string | null }>> {
    const rows = (await principalQ
      .list(this.db, kind, tenantId ?? null)
      .execute()) as unknown as Array<
      PrincipalRow & { created_at: string; last_login_at: string | null }
    >;
    return rows.map((r) => ({
      ...toPrincipal(r),
      createdAt: new Date(r.created_at).toISOString(),
      lastLoginAt: r.last_login_at ? new Date(r.last_login_at).toISOString() : null,
    }));
  }

  async setStatus(id: string, status: "active" | "disabled"): Promise<void> {
    await principalQ.setStatus(this.db, id, status).execute();

    if (status === "disabled") await this.revokeAllSessions(id, "account disabled");
  }

  async setPassword(id: string, password: string, mustChange = false): Promise<void> {
    await principalQ.setPassword(this.db, id, await hashPassword(password), mustChange).execute();
  }

  async verifyCredentials(input: {
    kind: PrincipalKind;
    email: string;
    password: string;
    tenantId?: string | null;
    now?: Date;
  }): Promise<
    | { outcome: "ok"; principal: Principal }
    | { outcome: "mfa_required"; principal: Principal }
    | { outcome: "mfa_enrolment_required"; principal: Principal }
  > {
    const now = input.now ?? new Date();
    const row = await this.loadByEmail(input.kind, input.email, input.tenantId);

    if (!row) {
      await verifyPassword(input.password, `scrypt$65536$8$1$${"A".repeat(22)}$${"A".repeat(43)}`);
      throw new AuthError("Email or password is incorrect", { exposable: true });
    }

    if (row.locked_until && new Date(row.locked_until) > now) {
      throw new AccountLockedError(
        "Too many failed attempts. Try again later or use a recovery code.",
        { exposable: true },
      );
    }
    if (row.status !== "active") {
      throw new AuthError("This account is disabled", { exposable: true });
    }

    const good = await verifyPassword(input.password, row.password_hash);
    if (!good) {
      const failures = row.failed_logins + 1;
      const lock = failures >= this.config.maxFailedLogins;
      await principalQ
        .recordFailure(
          this.db,
          row.id,
          failures,
          lock ? new Date(now.getTime() + this.config.lockoutMs) : null,
        )
        .execute();
      throw new AuthError("Email or password is incorrect", { exposable: true });
    }

    await principalQ.clearFailures(this.db, row.id).execute();

    if (needsRehash(row.password_hash)) {
      await principalQ
        .rehashPassword(this.db, row.id, await hashPassword(input.password))
        .execute();
    }

    const principal = toPrincipal(row);
    if (requiresTotp(principal.role)) {
      if (!principal.totpConfirmed) return { outcome: "mfa_enrolment_required", principal };
      return { outcome: "mfa_required", principal };
    }
    return { outcome: "ok", principal };
  }

  async verifySecondFactor(principalId: string, code: string, now = new Date()): Promise<boolean> {
    const totp = await principalTotp.confirmedSecret(this.db, principalId).executeTakeFirst();
    if (totp) {
      const res = verifyTotp(totp.secret, code, {
        now,
        lastStep: totp.last_step == null ? null : Number(totp.last_step),
      });
      if (res.ok) {
        await principalTotp.advanceStep(this.db, principalId, String(res.step ?? "")).execute();
        return true;
      }
    }
    return this.consumeRecoveryCode(principalId, code);
  }

  private async consumeRecoveryCode(principalId: string, code: string): Promise<boolean> {
    const spent = await recoveryCode
      .spend(this.db, principalId, hashToken(code.trim().toLowerCase()))
      .execute();
    return spent.length > 0;
  }

  async beginTotpEnrolment(principalId: string): Promise<string> {
    const secret = generateTotpSecret();
    await principalTotp.upsertPending(this.db, principalId, secret).execute();
    return secret;
  }

  async confirmTotp(principalId: string, code: string, now = new Date()): Promise<string[]> {
    const secret = (await principalTotp.pendingSecret(this.db, principalId).executeTakeFirst())
      ?.secret;
    if (!secret) throw new AuthError("Start enrolment first", { exposable: true });

    const res = verifyTotp(secret, code, { now, lastStep: null });
    if (!res.ok) throw new AuthError("That code is not correct", { exposable: true });

    const codes = generateRecoveryCodes();
    await this.sql.transaction(async (tx) => {
      const db = kyselyFor(tx);
      await principalTotp.confirm(db, principalId, String(res.step ?? "")).execute();
      await recoveryCode.deleteFor(db, principalId).execute();
      for (const c of codes) {
        await recoveryCode.insert(db, principalId, hashToken(c)).execute();
      }
    });
    return codes;
  }

  async createSession(
    principalId: string,
    meta: { ip?: string | null; userAgent?: string | null } = {},
    now = new Date(),
  ): Promise<{ token: string; csrfToken: string; session: Session }> {
    const token = randomToken();
    const csrfToken = randomToken();
    const id = randomUUID();
    const expiresAt = new Date(now.getTime() + this.config.absoluteMs);
    const idleExpiresAt = new Date(now.getTime() + this.config.idleMs);

    await authSession
      .insert(this.db, {
        id,
        principal_id: principalId,
        token_hash: hashToken(token),
        csrf_token: csrfToken,
        idle_expires_at: idleExpiresAt,
        expires_at: expiresAt,
        ip: meta.ip ?? null,
        user_agent: (meta.userAgent ?? "").slice(0, 300) || null,
      })
      .execute();
    await principalQ.touchLastLogin(this.db, principalId).execute();

    return {
      token,
      csrfToken,
      session: {
        id,
        principalId,
        createdAt: now,
        lastSeenAt: now,
        expiresAt,
        idleExpiresAt,
        ip: meta.ip ?? null,
        userAgent: meta.userAgent ?? null,
      },
    };
  }

  async resolveSession(
    token: string,
    now = new Date(),
  ): Promise<{ principal: Principal; session: Session; csrfToken: string } | null> {
    const rows = await authSession.resolveByTokenHash(this.db, hashToken(token), now).execute();
    const r = rows[0];
    if (!r) return null;

    const idleExpiresAt = new Date(now.getTime() + this.config.idleMs);

    const capped = new Date(Math.min(idleExpiresAt.getTime(), new Date(r.expires_at).getTime()));
    await authSession.slide(this.db, r.id, now, capped).execute();

    return {
      csrfToken: r.csrf_token,
      principal: {
        id: r.principal_id,
        kind: r.p_kind as PrincipalKind,
        tenantId: r.p_tenant,
        email: r.p_email,
        role: r.p_role as Role,
        status: r.p_status as "active" | "disabled",
        mustChangePassword: r.p_must_change,
        totpConfirmed: r.totp_confirmed != null,
      },
      session: {
        id: r.id,
        principalId: r.principal_id,
        createdAt: new Date(r.created_at),
        lastSeenAt: now,
        expiresAt: new Date(r.expires_at),
        idleExpiresAt: capped,
        ip: r.ip,
        userAgent: r.user_agent,
      },
    };
  }

  async revokeSession(id: string, reason = "signed out"): Promise<boolean> {
    const revoked = await authSession.revoke(this.db, id, reason).execute();
    return revoked.length > 0;
  }

  async revokeAllSessions(principalId: string, reason = "signed out everywhere"): Promise<number> {
    const revoked = await authSession.revokeAllFor(this.db, principalId, reason).execute();
    return revoked.length;
  }

  async listSessions(principalId: string, now = new Date()): Promise<Session[]> {
    const rows = await authSession.liveFor(this.db, principalId, now).execute();
    return rows.map((r) => ({
      id: r.id,
      principalId,
      createdAt: new Date(r.created_at),
      lastSeenAt: new Date(r.last_seen_at),
      idleExpiresAt: new Date(r.idle_expires_at),
      expiresAt: new Date(r.expires_at),
      ip: r.ip,
      userAgent: r.user_agent,
    }));
  }

  async pruneSessions(olderThan: Date): Promise<number> {
    const rows = await authSession.deleteExpired(this.db, olderThan).execute();
    return rows.length;
  }

  async recordAttempt(entry: {
    email?: string | null;
    principalId?: string | null;
    kind: string;
    outcome: string;
    ip?: string | null;
    userAgent?: string | null;
    detail?: string | null;
  }): Promise<void> {
    await authAttempt
      .insert(this.db, {
        email: entry.email ?? null,
        principal_id: entry.principalId ?? null,
        kind: entry.kind,
        outcome: entry.outcome,
        ip: entry.ip ?? null,
        user_agent: (entry.userAgent ?? "").slice(0, 300) || null,
        detail: entry.detail ?? null,
      })
      .execute();
  }

  async listAttempts(limit = 100): Promise<
    Array<{
      at: string;
      email: string | null;
      kind: string;
      outcome: string;
      ip: string | null;
      detail: string | null;
    }>
  > {
    const rows = await authAttempt.recent(this.db, Math.min(Math.max(1, limit), 500)).execute();
    return rows.map((r) => ({ ...r, at: new Date(r.at).toISOString() }));
  }
}
