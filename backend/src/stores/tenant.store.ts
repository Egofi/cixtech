import { createHash, randomBytes, randomUUID } from "node:crypto";
import { AccountNotFoundError, InvalidScopesError, UnauthorizedError } from "@/common";
import { kyselyFor } from "@/postgres";
import { account as accountQ, apiKey as apiKeyQ, tenant as tenantQ } from "@/queries";
import { type Account, type Db, SCOPES, type Scope, type SqlClient, type Tenant } from "@/types";

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

const hashKey = (key: string): string => createHash("sha256").update(key).digest("hex");

export class TenantStore {
  private readonly db: Db;

  constructor(private readonly sql: SqlClient) {
    this.db = kyselyFor(sql);
  }

  async createTenant(
    name: string,
    scopes: readonly Scope[] = SCOPES,
  ): Promise<{ tenant: Tenant; apiKey: string }> {
    const id = randomUUID();
    const keyId = randomUUID();
    const apiKey = `cxk_${randomBytes(24).toString("hex")}`;
    await tenantQ.insert(this.db, id, name).execute();
    await apiKeyQ
      .insert(this.db, { key_hash: hashKey(apiKey), tenant_id: id, id: keyId, scopes: [...scopes] })
      .execute();
    return { tenant: { id, name, keyId, scopes }, apiKey };
  }

  async authenticate(apiKey: string | undefined): Promise<Tenant> {
    if (!apiKey) throw new UnauthorizedError("Missing API key", { exposable: true });
    const row = await apiKeyQ.authenticate(this.db, hashKey(apiKey)).executeTakeFirst();

    if (!row) throw new UnauthorizedError("Invalid API key", { exposable: true });
    return {
      id: row.id,
      name: row.name,
      keyId: row.key_id,
      scopes: (row.scopes ?? [...SCOPES]) as Scope[],
    };
  }

  async issueKey(
    tenantId: string,
    scopes: readonly Scope[] = SCOPES,
    label?: string,
  ): Promise<string> {
    const found = await tenantQ.exists(this.db, tenantId).executeTakeFirst();
    if (!found) throw new AccountNotFoundError(`Tenant ${tenantId} not found`);
    const apiKey = `cxk_${randomBytes(24).toString("hex")}`;
    await apiKeyQ
      .insert(this.db, {
        key_hash: hashKey(apiKey),
        tenant_id: tenantId,
        id: randomUUID(),
        scopes: [...scopes],
        label: label ?? null,
      })
      .execute();
    return apiKey;
  }

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
    const rows = await apiKeyQ.listFor(this.db, tenantId).execute();
    return rows.map((k) => ({
      id: k.id,
      label: k.label,
      scopes: (k.scopes ?? [...SCOPES]) as Scope[],
      createdAt: k.created_at.toISOString(),
      revokedAt: k.revoked_at ? k.revoked_at.toISOString() : null,
      revokedReason: k.revoked_reason,
    }));
  }

  async rotateKeys(
    tenantId: string,
    opts: { reason?: string; scopes?: readonly Scope[]; label?: string } = {},
  ): Promise<{ apiKey: string; keyId: string; revokedKeyIds: string[] }> {
    return this.sql.transaction(async (tx) => {
      const db = kyselyFor(tx);
      const t = await tenantQ.exists(db, tenantId).executeTakeFirst();
      if (!t) throw new AccountNotFoundError(`Tenant ${tenantId} not found`);

      const live = await apiKeyQ.liveIdsFor(db, tenantId).execute();

      const apiKey = `cxk_${randomBytes(24).toString("hex")}`;
      const keyId = randomUUID();
      await apiKeyQ
        .insert(db, {
          key_hash: hashKey(apiKey),
          tenant_id: tenantId,
          id: keyId,
          scopes: [...(opts.scopes ?? SCOPES)],
          label: opts.label ?? "rotated",
        })
        .execute();

      const revokedKeyIds = live.map((k) => k.id);
      if (revokedKeyIds.length > 0) {
        await apiKeyQ.revokeMany(db, revokedKeyIds, opts.reason ?? "rotated").execute();
      }
      return { apiKey, keyId, revokedKeyIds };
    });
  }

  async revokeKey(tenantId: string, keyId: string, reason?: string): Promise<boolean> {
    const revoked = await apiKeyQ.revoke(this.db, tenantId, keyId, reason ?? "revoked").execute();
    return revoked.length > 0;
  }

  async listAccounts(
    tenantId: string,
    limit = 50,
  ): Promise<Array<Account & { createdAt: string }>> {
    const rows = await accountQ.listFor(this.db, tenantId, limit).execute();
    return rows.map((row) => ({
      id: row.id,
      tenantId: row.tenant_id,
      externalRef: row.external_ref,
      createdAt: new Date(row.created_at).toISOString(),
    }));
  }

  async createAccount(tenantId: string, externalRef: string | null): Promise<Account> {
    const id = randomUUID();
    await accountQ.insert(this.db, id, tenantId, externalRef).execute();
    return { id, tenantId, externalRef };
  }

  async requireAccount(tenantId: string, accountId: string): Promise<Account> {
    const row = await accountQ.ownedBy(this.db, accountId, tenantId).executeTakeFirst();
    if (!row) throw new AccountNotFoundError(`Account ${accountId} not found`, { exposable: true });
    return { id: row.id, tenantId: row.tenant_id, externalRef: row.external_ref };
  }
}
