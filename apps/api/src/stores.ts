import { createHash, randomBytes, randomUUID } from "node:crypto";
import { AppError } from "@cixtech/errors";
import type { SqlClient } from "@cixtech/ledger";

/** API-key scopes (build spec §16). `approve` never implies `move-funds`. */
export const SCOPES = ["read", "move-funds", "approve"] as const;
export type Scope = (typeof SCOPES)[number];

/**
 * Validate a caller-supplied scope list, rejecting anything unrecognised.
 *
 * Every key used to be minted with the full `SCOPES` tuple because that was the
 * default and no route ever passed anything else — which made the documented
 * "`approve` does not imply `move-funds`" boundary impossible to actually
 * configure, and reduced dual control to two equally-privileged keys in the same
 * vault. Scopes are only a boundary if a key can be issued without all of them.
 */
export function parseScopes(input: unknown): readonly Scope[] {
  if (input === undefined || input === null) return SCOPES;
  if (!Array.isArray(input) || input.length === 0) {
    throw new InvalidScopesError("scopes must be a non-empty array", { exposable: true });
  }
  const bad = input.filter((s) => !SCOPES.includes(s as Scope));
  if (bad.length > 0) {
    throw new InvalidScopesError(
      `Unknown scope(s): ${bad.join(", ")}. Valid scopes are ${SCOPES.join(", ")}.`,
      { context: { valid: SCOPES.join(",") }, exposable: true },
    );
  }
  return [...new Set(input as Scope[])];
}

/** Everything a tenant key is allowed to do, plus the identity it acts as. */
export interface Tenant {
  id: string;
  name: string;
  /** Stable id of the API key used — the identity for separation of duties (§7.4). */
  keyId: string;
  scopes: readonly Scope[];
}

export class ForbiddenScopeError extends AppError {
  readonly code = "FORBIDDEN_SCOPE";
}
/** A key was requested with a scope list the engine does not recognise. */
export class InvalidScopesError extends AppError {
  readonly code = "INVALID_SCOPES";
}
export interface Account {
  id: string;
  tenantId: string;
  externalRef: string | null;
}

export class UnauthorizedError extends AppError {
  readonly code = "UNAUTHORIZED";
}
export class AccountNotFoundError extends AppError {
  readonly code = "ACCOUNT_NOT_FOUND";
}

const hashKey = (key: string): string => createHash("sha256").update(key).digest("hex");

/** Tenants, their (hashed) API keys, and their accounts — with tenant isolation. */
export class TenantStore {
  constructor(private readonly sql: SqlClient) {}

  /** Create a tenant + an API key. The plaintext key is returned ONCE and never stored. */
  async createTenant(
    name: string,
    scopes: readonly Scope[] = SCOPES,
  ): Promise<{ tenant: Tenant; apiKey: string }> {
    const id = randomUUID();
    const keyId = randomUUID();
    const apiKey = `cxk_${randomBytes(24).toString("hex")}`;
    await this.sql.query("INSERT INTO tenant (id, name) VALUES ($1, $2)", [id, name]);
    await this.sql.query(
      "INSERT INTO api_key (key_hash, tenant_id, id, scopes) VALUES ($1, $2, $3, $4)",
      [hashKey(apiKey), id, keyId, [...scopes]],
    );
    return { tenant: { id, name, keyId, scopes }, apiKey };
  }

  /** Resolve an API key to its tenant + scopes, or throw Unauthorized. */
  async authenticate(apiKey: string | undefined): Promise<Tenant> {
    if (!apiKey) throw new UnauthorizedError("Missing API key", { exposable: true });
    const r = await this.sql.query<{
      id: string;
      name: string;
      key_id: string;
      scopes: string[] | null;
    }>(
      `SELECT t.id, t.name, k.id AS key_id, k.scopes FROM api_key k JOIN tenant t ON t.id = k.tenant_id
       WHERE k.key_hash = $1 AND k.revoked_at IS NULL`,
      [hashKey(apiKey)],
    );
    const row = r.rows[0];
    // A revoked key is indistinguishable from a wrong one here, deliberately: the
    // holder of a leaked key learns nothing about whether it was ever valid.
    if (!row) throw new UnauthorizedError("Invalid API key", { exposable: true });
    return {
      id: row.id,
      name: row.name,
      keyId: row.key_id,
      scopes: (row.scopes ?? [...SCOPES]) as Scope[],
    };
  }

  /**
   * Issue an ADDITIONAL API key for an existing tenant (lost-key recovery via the
   * admin plane). The plaintext is returned once and only its hash is stored;
   * previously issued keys stay valid. Use `rotateKeys` when the old ones must
   * stop working.
   */
  async issueKey(
    tenantId: string,
    scopes: readonly Scope[] = SCOPES,
    label?: string,
  ): Promise<string> {
    const r = await this.sql.query<{ id: string }>("SELECT id FROM tenant WHERE id = $1", [
      tenantId,
    ]);
    if (!r.rows[0]) throw new AccountNotFoundError(`Tenant ${tenantId} not found`);
    const apiKey = `cxk_${randomBytes(24).toString("hex")}`;
    await this.sql.query(
      "INSERT INTO api_key (key_hash, tenant_id, id, scopes, label) VALUES ($1, $2, $3, $4, $5)",
      [hashKey(apiKey), tenantId, randomUUID(), [...scopes], label ?? null],
    );
    return apiKey;
  }

  /** A tenant's credentials — identity and status only; the key itself is unrecoverable. */
  async listKeys(tenantId: string): Promise<
    Array<{
      id: string;
      label: string | null;
      scopes: Scope[];
      createdAt: string;
      revokedAt: string | null;
      revokedReason: string | null;
    }>
  > {
    const r = await this.sql.query<{
      id: string;
      label: string | null;
      scopes: string[] | null;
      created_at: string;
      revoked_at: string | null;
      revoked_reason: string | null;
    }>(
      `SELECT id, label, scopes, created_at, revoked_at, revoked_reason FROM api_key
       WHERE tenant_id = $1 ORDER BY created_at DESC`,
      [tenantId],
    );
    return r.rows.map((k) => ({
      id: k.id,
      label: k.label,
      scopes: (k.scopes ?? [...SCOPES]) as Scope[],
      createdAt: k.created_at,
      revokedAt: k.revoked_at,
      revokedReason: k.revoked_reason,
    }));
  }

  /**
   * Rotate a tenant's credentials: mint a replacement and revoke every key that
   * was live beforehand, in ONE transaction.
   *
   * The ordering matters. Issuing first means the tenant is never without a working
   * credential; revoking only the keys observed inside the transaction means a key
   * issued concurrently is not caught in the sweep. Doing both atomically is what
   * stops a crash between the two steps from either locking the tenant out (revoked,
   * nothing issued) or leaving the leaked key live (issued, nothing revoked).
   *
   * Returns the plaintext ONCE, plus the ids of what it retired — the caller audits
   * the ids, never the key.
   */
  async rotateKeys(
    tenantId: string,
    opts: { reason?: string; scopes?: readonly Scope[]; label?: string } = {},
  ): Promise<{ apiKey: string; keyId: string; revokedKeyIds: string[] }> {
    return this.sql.transaction(async (tx) => {
      const t = await tx.query<{ id: string }>("SELECT id FROM tenant WHERE id = $1", [tenantId]);
      if (!t.rows[0]) throw new AccountNotFoundError(`Tenant ${tenantId} not found`);

      const live = await tx.query<{ id: string }>(
        "SELECT id FROM api_key WHERE tenant_id = $1 AND revoked_at IS NULL",
        [tenantId],
      );

      const apiKey = `cxk_${randomBytes(24).toString("hex")}`;
      const keyId = randomUUID();
      await tx.query(
        "INSERT INTO api_key (key_hash, tenant_id, id, scopes, label) VALUES ($1, $2, $3, $4, $5)",
        [hashKey(apiKey), tenantId, keyId, [...(opts.scopes ?? SCOPES)], opts.label ?? "rotated"],
      );

      const revokedKeyIds = live.rows.map((k) => k.id);
      if (revokedKeyIds.length > 0) {
        await tx.query(
          `UPDATE api_key SET revoked_at = now(), revoked_reason = $2
             WHERE id = ANY($1) AND revoked_at IS NULL`,
          [revokedKeyIds, opts.reason ?? "rotated"],
        );
      }
      return { apiKey, keyId, revokedKeyIds };
    });
  }

  /** Revoke ONE credential by its id. Returns false when it was already revoked or unknown. */
  async revokeKey(tenantId: string, keyId: string, reason?: string): Promise<boolean> {
    const r = await this.sql.query<{ id: string }>(
      `UPDATE api_key SET revoked_at = now(), revoked_reason = $3
         WHERE tenant_id = $1 AND id = $2 AND revoked_at IS NULL
       RETURNING id`,
      [tenantId, keyId, reason ?? "revoked"],
    );
    return r.rows.length > 0;
  }

  /** All of a tenant's sub-accounts, newest first. */
  async listAccounts(
    tenantId: string,
    limit = 50,
  ): Promise<Array<Account & { createdAt: string }>> {
    const r = await this.sql.query<{
      id: string;
      tenant_id: string;
      external_ref: string | null;
      created_at: string;
    }>(
      `SELECT id, tenant_id, external_ref, created_at FROM account
        WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [tenantId, limit],
    );
    return r.rows.map((row) => ({
      id: row.id,
      tenantId: row.tenant_id,
      externalRef: row.external_ref,
      createdAt: new Date(row.created_at).toISOString(),
    }));
  }

  async createAccount(tenantId: string, externalRef: string | null): Promise<Account> {
    const id = randomUUID();
    await this.sql.query("INSERT INTO account (id, tenant_id, external_ref) VALUES ($1, $2, $3)", [
      id,
      tenantId,
      externalRef,
    ]);
    return { id, tenantId, externalRef };
  }

  /** Fetch an account, enforcing that it belongs to the authenticated tenant. */
  async requireAccount(tenantId: string, accountId: string): Promise<Account> {
    const r = await this.sql.query<{ id: string; tenant_id: string; external_ref: string | null }>(
      "SELECT id, tenant_id, external_ref FROM account WHERE id = $1 AND tenant_id = $2",
      [accountId, tenantId],
    );
    const row = r.rows[0];
    if (!row) throw new AccountNotFoundError(`Account ${accountId} not found`, { exposable: true });
    return { id: row.id, tenantId: row.tenant_id, externalRef: row.external_ref };
  }
}
