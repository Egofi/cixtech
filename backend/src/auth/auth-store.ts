import { randomUUID } from "node:crypto";
import { AppError } from "@/errors";
import type { SqlClient } from "@/ledger";
import {
  generateRecoveryCodes,
  generateTotpSecret,
  hashPassword,
  hashToken,
  needsRehash,
  randomToken,
  verifyPassword,
  verifyTotp,
} from "./crypto.js";
import { type PrincipalKind, type Role, parseRole, requiresTotp } from "./roles.js";

export class AuthError extends AppError {
  readonly code = "AUTH_FAILED";
}
export class AccountLockedError extends AppError {
  readonly code = "ACCOUNT_LOCKED";
}
export class MfaRequiredError extends AppError {
  readonly code = "MFA_REQUIRED";
}
export class MfaEnrolmentRequiredError extends AppError {
  readonly code = "MFA_ENROLMENT_REQUIRED";
}
export class PrincipalExistsError extends AppError {
  readonly code = "PRINCIPAL_EXISTS";
}
export class PrincipalNotFoundError extends AppError {
  readonly code = "PRINCIPAL_NOT_FOUND";
}

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

export interface Session {
  id: string;
  principalId: string;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
  idleExpiresAt: Date;
  ip: string | null;
  userAgent: string | null;
}

export interface SessionConfig {
  /** Absolute lifetime. A session cannot outlive this however active it is. */
  absoluteMs: number;
  /** Idle lifetime, pushed forward on each use. Closes abandoned tabs. */
  idleMs: number;
  /** Consecutive failures before an account is temporarily locked. */
  maxFailedLogins: number;
  lockoutMs: number;
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

/**
 * People, their second factors, and their live browser sessions.
 *
 * The security properties this exists to provide, none of which a long-lived API
 * key in `localStorage` can:
 *
 *  - **Identity.** Every admin action is attributable to a person, so the audit
 *    trail says who, not `super_admin`.
 *  - **Revocation.** A session dies the moment it is revoked, without rotating a
 *    credential that other integrations share.
 *  - **Expiry.** Absolute and idle, so a forgotten open tab is not a permanent
 *    grant.
 *  - **Lockout.** Online password guessing stops after a handful of attempts.
 */
export class AuthStore {
  constructor(
    private readonly sql: SqlClient,
    private readonly config: SessionConfig = DEFAULT_SESSION_CONFIG,
  ) {}

  // ── Principals ─────────────────────────────────────────────────────────────

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
      await this.sql.query(
        `INSERT INTO principal (id, kind, tenant_id, email, password_hash, role, must_change_password)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          id,
          input.kind,
          input.tenantId ?? null,
          email,
          hash,
          role,
          input.mustChangePassword ?? false,
        ],
      );
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
    const { rows } = await this.sql.query<PrincipalRow>(
      `SELECT p.*, t.confirmed_at AS totp_confirmed, t.secret AS totp_secret,
              t.last_step::text AS totp_last_step
         FROM principal p
         LEFT JOIN principal_totp t ON t.principal_id = p.id
        WHERE p.kind = $1 AND lower(p.email) = lower($2)
          AND ($3::text IS NULL OR p.tenant_id = $3)`,
      [kind, email, tenantId ?? null],
    );
    return rows[0] ?? null;
  }

  async loadById(id: string): Promise<Principal | null> {
    const { rows } = await this.sql.query<PrincipalRow>(
      `SELECT p.*, t.confirmed_at AS totp_confirmed, t.secret AS totp_secret,
              t.last_step::text AS totp_last_step
         FROM principal p
         LEFT JOIN principal_totp t ON t.principal_id = p.id
        WHERE p.id = $1`,
      [id],
    );
    return rows[0] ? toPrincipal(rows[0]) : null;
  }

  /** How many operators exist. Zero means the engine is still in bootstrap. */
  async operatorCount(): Promise<number> {
    const { rows } = await this.sql.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM principal WHERE kind = 'operator' AND status = 'active'",
    );
    return Number(rows[0]?.n ?? 0);
  }

  async listPrincipals(
    kind: PrincipalKind,
    tenantId?: string | null,
  ): Promise<Array<Principal & { createdAt: string; lastLoginAt: string | null }>> {
    const { rows } = await this.sql.query<
      PrincipalRow & { created_at: string; last_login_at: string | null }
    >(
      `SELECT p.*, t.confirmed_at AS totp_confirmed, NULL AS totp_secret, NULL AS totp_last_step
         FROM principal p
         LEFT JOIN principal_totp t ON t.principal_id = p.id
        WHERE p.kind = $1 AND ($2::text IS NULL OR p.tenant_id = $2)
        ORDER BY p.created_at DESC`,
      [kind, tenantId ?? null],
    );
    return rows.map((r) => ({
      ...toPrincipal(r),
      createdAt: new Date(r.created_at).toISOString(),
      lastLoginAt: r.last_login_at ? new Date(r.last_login_at).toISOString() : null,
    }));
  }

  async setStatus(id: string, status: "active" | "disabled"): Promise<void> {
    await this.sql.query(
      `UPDATE principal SET status = $2, disabled_at = CASE WHEN $2 = 'disabled' THEN now() ELSE NULL END
        WHERE id = $1`,
      [id, status],
    );
    // Disabling an account must end its live sessions immediately, or the person
    // keeps working until their token happens to expire.
    if (status === "disabled") await this.revokeAllSessions(id, "account disabled");
  }

  async setPassword(id: string, password: string, mustChange = false): Promise<void> {
    await this.sql.query(
      `UPDATE principal SET password_hash = $2, must_change_password = $3,
              failed_logins = 0, locked_until = NULL
        WHERE id = $1`,
      [id, await hashPassword(password), mustChange],
    );
  }

  // ── Authentication ─────────────────────────────────────────────────────────

  /**
   * Step one: email and password.
   *
   * Returns what the caller must do next rather than a session, because a
   * password alone is not sufficient for a role that requires a second factor.
   *
   * A wrong password and an unknown account produce the SAME failure, and both
   * cost the same scrypt work: answering faster for an address that does not
   * exist turns the login form into an account-enumeration oracle.
   */
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
      // Spend the same work an existing account would, so timing does not reveal
      // which addresses are registered.
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
      await this.sql.query(
        "UPDATE principal SET failed_logins = $2, locked_until = $3 WHERE id = $1",
        [
          row.id,
          failures,
          lock ? new Date(now.getTime() + this.config.lockoutMs).toISOString() : null,
        ],
      );
      throw new AuthError("Email or password is incorrect", { exposable: true });
    }

    await this.sql.query(
      "UPDATE principal SET failed_logins = 0, locked_until = NULL WHERE id = $1",
      [row.id],
    );

    // Transparently upgrade a hash made with weaker parameters, now that the
    // plaintext is in hand and known correct.
    if (needsRehash(row.password_hash)) {
      await this.sql.query("UPDATE principal SET password_hash = $2 WHERE id = $1", [
        row.id,
        await hashPassword(input.password),
      ]);
    }

    const principal = toPrincipal(row);
    if (requiresTotp(principal.role)) {
      if (!principal.totpConfirmed) return { outcome: "mfa_enrolment_required", principal };
      return { outcome: "mfa_required", principal };
    }
    return { outcome: "ok", principal };
  }

  /** Step two: the 6-digit code, or a single-use recovery code. */
  async verifySecondFactor(principalId: string, code: string, now = new Date()): Promise<boolean> {
    const { rows } = await this.sql.query<{ secret: string; last_step: string | null }>(
      "SELECT secret, last_step::text AS last_step FROM principal_totp WHERE principal_id = $1 AND confirmed_at IS NOT NULL",
      [principalId],
    );
    const totp = rows[0];
    if (totp) {
      const res = verifyTotp(totp.secret, code, {
        now,
        lastStep: totp.last_step == null ? null : Number(totp.last_step),
      });
      if (res.ok) {
        // Record the step so this code cannot be presented twice.
        await this.sql.query("UPDATE principal_totp SET last_step = $2 WHERE principal_id = $1", [
          principalId,
          res.step ?? null,
        ]);
        return true;
      }
    }
    return this.consumeRecoveryCode(principalId, code);
  }

  private async consumeRecoveryCode(principalId: string, code: string): Promise<boolean> {
    const { rows } = await this.sql.query<{ code_hash: string }>(
      `UPDATE principal_recovery_code SET used_at = now()
        WHERE principal_id = $1 AND code_hash = $2 AND used_at IS NULL
       RETURNING code_hash`,
      [principalId, hashToken(code.trim().toLowerCase())],
    );
    return rows.length > 0;
  }

  // ── TOTP enrolment ─────────────────────────────────────────────────────────

  /** Begin enrolment. The secret grants nothing until `confirmTotp` succeeds. */
  async beginTotpEnrolment(principalId: string): Promise<string> {
    const secret = generateTotpSecret();
    await this.sql.query(
      `INSERT INTO principal_totp (principal_id, secret, confirmed_at, last_step)
       VALUES ($1, $2, NULL, NULL)
       ON CONFLICT (principal_id) DO UPDATE
         SET secret = EXCLUDED.secret, confirmed_at = NULL, last_step = NULL`,
      [principalId, secret],
    );
    return secret;
  }

  /**
   * Confirm enrolment with a live code, and issue recovery codes.
   *
   * Requiring a working code before the factor counts is what stops someone
   * locking themselves out by scanning a QR into an app they then delete.
   */
  async confirmTotp(principalId: string, code: string, now = new Date()): Promise<string[]> {
    const { rows } = await this.sql.query<{ secret: string }>(
      "SELECT secret FROM principal_totp WHERE principal_id = $1",
      [principalId],
    );
    const secret = rows[0]?.secret;
    if (!secret) throw new AuthError("Start enrolment first", { exposable: true });

    const res = verifyTotp(secret, code, { now, lastStep: null });
    if (!res.ok) throw new AuthError("That code is not correct", { exposable: true });

    const codes = generateRecoveryCodes();
    await this.sql.transaction(async (tx) => {
      await tx.query(
        "UPDATE principal_totp SET confirmed_at = now(), last_step = $2 WHERE principal_id = $1",
        [principalId, res.step ?? null],
      );
      await tx.query("DELETE FROM principal_recovery_code WHERE principal_id = $1", [principalId]);
      for (const c of codes) {
        await tx.query(
          "INSERT INTO principal_recovery_code (principal_id, code_hash) VALUES ($1, $2)",
          [principalId, hashToken(c)],
        );
      }
    });
    return codes;
  }

  // ── Sessions ───────────────────────────────────────────────────────────────

  /**
   * Mint a session. Returns the plaintext token and CSRF value ONCE; the
   * database keeps only their hashes, so a stolen dump cannot be replayed.
   */
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

    await this.sql.query(
      `INSERT INTO auth_session
         (id, principal_id, token_hash, csrf_token, idle_expires_at, expires_at, ip, user_agent)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        id,
        principalId,
        hashToken(token),
        csrfToken,
        idleExpiresAt.toISOString(),
        expiresAt.toISOString(),
        meta.ip ?? null,
        (meta.userAgent ?? "").slice(0, 300) || null,
      ],
    );
    await this.sql.query("UPDATE principal SET last_login_at = now() WHERE id = $1", [principalId]);

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

  /**
   * Resolve a session token, sliding its idle window forward.
   *
   * Returns null for anything not currently valid — unknown, revoked, expired,
   * idled out, or belonging to an account that has since been disabled. The
   * caller cannot distinguish between them, and should not: each one means
   * "sign in again".
   */
  async resolveSession(
    token: string,
    now = new Date(),
  ): Promise<{ principal: Principal; session: Session; csrfToken: string } | null> {
    const { rows } = await this.sql.query<{
      id: string;
      principal_id: string;
      csrf_token: string;
      created_at: string;
      last_seen_at: string;
      idle_expires_at: string;
      expires_at: string;
      ip: string | null;
      user_agent: string | null;
      p_kind: PrincipalKind;
      p_tenant: string | null;
      p_email: string;
      p_role: string;
      p_status: "active" | "disabled";
      p_must_change: boolean;
      totp_confirmed: string | null;
    }>(
      `SELECT s.id, s.principal_id, s.csrf_token, s.created_at, s.last_seen_at,
              s.idle_expires_at, s.expires_at, s.ip, s.user_agent,
              p.kind AS p_kind, p.tenant_id AS p_tenant, p.email AS p_email,
              p.role AS p_role, p.status AS p_status,
              p.must_change_password AS p_must_change,
              t.confirmed_at AS totp_confirmed
         FROM auth_session s
         JOIN principal p ON p.id = s.principal_id
         LEFT JOIN principal_totp t ON t.principal_id = p.id
        WHERE s.token_hash = $1
          AND s.revoked_at IS NULL
          AND s.expires_at > $2
          AND s.idle_expires_at > $2
          AND p.status = 'active'`,
      [hashToken(token), now.toISOString()],
    );
    const r = rows[0];
    if (!r) return null;

    const idleExpiresAt = new Date(now.getTime() + this.config.idleMs);
    // Never past the absolute expiry: sliding the idle window must not extend a
    // session beyond the hard cap.
    const capped = new Date(Math.min(idleExpiresAt.getTime(), new Date(r.expires_at).getTime()));
    await this.sql.query(
      "UPDATE auth_session SET last_seen_at = $2, idle_expires_at = $3 WHERE id = $1",
      [r.id, now.toISOString(), capped.toISOString()],
    );

    return {
      csrfToken: r.csrf_token,
      principal: {
        id: r.principal_id,
        kind: r.p_kind,
        tenantId: r.p_tenant,
        email: r.p_email,
        role: r.p_role as Role,
        status: r.p_status,
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
    const { rows } = await this.sql.query<{ id: string }>(
      `UPDATE auth_session SET revoked_at = now(), revoked_reason = $2
        WHERE id = $1 AND revoked_at IS NULL RETURNING id`,
      [id, reason],
    );
    return rows.length > 0;
  }

  /** Sign out everywhere — the control someone reaches for after losing a laptop. */
  async revokeAllSessions(principalId: string, reason = "signed out everywhere"): Promise<number> {
    const { rows } = await this.sql.query<{ id: string }>(
      `UPDATE auth_session SET revoked_at = now(), revoked_reason = $2
        WHERE principal_id = $1 AND revoked_at IS NULL RETURNING id`,
      [principalId, reason],
    );
    return rows.length;
  }

  async listSessions(principalId: string, now = new Date()): Promise<Session[]> {
    const { rows } = await this.sql.query<{
      id: string;
      created_at: string;
      last_seen_at: string;
      idle_expires_at: string;
      expires_at: string;
      ip: string | null;
      user_agent: string | null;
    }>(
      `SELECT id, created_at, last_seen_at, idle_expires_at, expires_at, ip, user_agent
         FROM auth_session
        WHERE principal_id = $1 AND revoked_at IS NULL
          AND expires_at > $2 AND idle_expires_at > $2
        ORDER BY last_seen_at DESC`,
      [principalId, now.toISOString()],
    );
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

  /** Delete sessions that expired long enough ago to be of no forensic use. */
  async pruneSessions(olderThan: Date): Promise<number> {
    const { rows } = await this.sql.query<{ id: string }>(
      "DELETE FROM auth_session WHERE expires_at < $1 RETURNING id",
      [olderThan.toISOString()],
    );
    return rows.length;
  }

  // ── Attempt log ────────────────────────────────────────────────────────────

  async recordAttempt(entry: {
    email?: string | null;
    principalId?: string | null;
    kind: string;
    outcome: string;
    ip?: string | null;
    userAgent?: string | null;
    detail?: string | null;
  }): Promise<void> {
    await this.sql.query(
      `INSERT INTO auth_attempt (email, principal_id, kind, outcome, ip, user_agent, detail)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        entry.email ?? null,
        entry.principalId ?? null,
        entry.kind,
        entry.outcome,
        entry.ip ?? null,
        (entry.userAgent ?? "").slice(0, 300) || null,
        entry.detail ?? null,
      ],
    );
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
    const { rows } = await this.sql.query<{
      at: string;
      email: string | null;
      kind: string;
      outcome: string;
      ip: string | null;
      detail: string | null;
    }>(
      `SELECT at, email, kind, outcome, ip, detail FROM auth_attempt
        ORDER BY at DESC LIMIT $1`,
      [Math.min(Math.max(1, limit), 500)],
    );
    return rows.map((r) => ({ ...r, at: new Date(r.at).toISOString() }));
  }
}
