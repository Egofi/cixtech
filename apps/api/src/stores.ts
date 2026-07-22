import { createHash, randomBytes, randomUUID } from "node:crypto";
import { AppError } from "@cixtech/errors";
import type { SqlClient } from "@cixtech/ledger";

export interface Tenant {
  id: string;
  name: string;
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
  async createTenant(name: string): Promise<{ tenant: Tenant; apiKey: string }> {
    const id = randomUUID();
    const apiKey = `cxk_${randomBytes(24).toString("hex")}`;
    await this.sql.query("INSERT INTO tenant (id, name) VALUES ($1, $2)", [id, name]);
    await this.sql.query("INSERT INTO api_key (key_hash, tenant_id) VALUES ($1, $2)", [
      hashKey(apiKey),
      id,
    ]);
    return { tenant: { id, name }, apiKey };
  }

  /** Resolve an API key to its tenant, or throw Unauthorized. */
  async authenticate(apiKey: string | undefined): Promise<Tenant> {
    if (!apiKey) throw new UnauthorizedError("Missing API key", { exposable: true });
    const r = await this.sql.query<{ id: string; name: string }>(
      `SELECT t.id, t.name FROM api_key k JOIN tenant t ON t.id = k.tenant_id
       WHERE k.key_hash = $1`,
      [hashKey(apiKey)],
    );
    const row = r.rows[0];
    if (!row) throw new UnauthorizedError("Invalid API key", { exposable: true });
    return { id: row.id, name: row.name };
  }

  /**
   * Issue an ADDITIONAL API key for an existing tenant (lost-key recovery via the
   * admin plane). The plaintext is returned once and only its hash is stored;
   * previously issued keys stay valid — revocation is a separate, future concern.
   */
  async issueKey(tenantId: string): Promise<string> {
    const r = await this.sql.query<{ id: string }>("SELECT id FROM tenant WHERE id = $1", [
      tenantId,
    ]);
    if (!r.rows[0]) throw new AccountNotFoundError(`Tenant ${tenantId} not found`);
    const apiKey = `cxk_${randomBytes(24).toString("hex")}`;
    await this.sql.query("INSERT INTO api_key (key_hash, tenant_id) VALUES ($1, $2)", [
      hashKey(apiKey),
      tenantId,
    ]);
    return apiKey;
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
