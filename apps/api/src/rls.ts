import type { SqlClient } from "@cixtech/ledger";

/**
 * Row-level security for every tenant-scoped table (build spec §13). Each table
 * that carries a tenant column gets RLS enabled and a policy keyed on the
 * `cixtech.tenant` GUC: a request that runs inside `withTenant` sees only its own
 * rows; an unset GUC (the trusted owner / cross-tenant admin plane) is unrestricted.
 * This is defense-in-depth beneath the query-level tenant scoping already enforced.
 *
 * `FORCE ROW LEVEL SECURITY` is load-bearing, not belt-and-braces: Postgres exempts
 * a table's OWNER from its policies unless the table is FORCEd, and on managed
 * Postgres the application role is normally the owner (Neon's `…_owner`, ADR 0013).
 * Without FORCE the policies below would parse, install, show up in `pg_policies` —
 * and filter nothing at all in production. (A superuser still bypasses RLS
 * regardless; the engine must not connect as one.)
 *
 * The boot-time guard (`assertTenantTablesProtected`) then FAILS STARTUP if any
 * table with a tenant column lacks a policy — so a new tenant-scoped table can
 * never ship without isolation, exactly as §13 requires.
 */
interface TenantTable {
  table: string;
  column: "tenant_id" | "tenant";
  /**
   * This table also holds SHARED rows, marked by an empty tenant value, that every
   * tenant must be able to read. Without this the policy hides them inside
   * `withTenant`, and a caller that reads config there sees nothing and silently
   * falls back to a default — a wrong answer rather than an error.
   */
  sharedWhenEmpty?: boolean;
}

const TENANT_TABLES: readonly TenantTable[] = [
  { table: "account", column: "tenant_id" },
  { table: "api_key", column: "tenant_id" },
  { table: "idempotency_key", column: "tenant_id" },
  { table: "webhook_endpoint", column: "tenant_id" },
  { table: "webhook_delivery", column: "tenant_id" },
  { table: "pool_address", column: "tenant" },
  { table: "policy_payout_log", column: "tenant" },
  { table: "payout_allowlist", column: "tenant" },
  { table: "payout_intent", column: "tenant" },
  { table: "payout_approval", column: "tenant" },
  { table: "agent_rule", column: "tenant_id" },
  { table: "ai_anomaly_log", column: "tenant_id" },
  // ADR 0011 toggle. A chain-wide default row carries tenant='' and must stay
  // readable inside a tenant-scoped transaction, or a mint would silently pick
  // the fallback strategy instead of the configured one.
  { table: "gather_config", column: "tenant", sharedWhenEmpty: true },
];

const policy = (t: TenantTable): string => `
ALTER TABLE ${t.table} ENABLE ROW LEVEL SECURITY;
ALTER TABLE ${t.table} FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ${t.table}_tenant_isolation ON ${t.table};
CREATE POLICY ${t.table}_tenant_isolation ON ${t.table}
  USING (
    current_setting('cixtech.tenant', true) IS NULL
    OR current_setting('cixtech.tenant', true) = ''
    OR ${t.column} = current_setting('cixtech.tenant', true)
    ${t.sharedWhenEmpty ? `OR ${t.column} = ''` : ""}
  );
`;

export const RLS_SCHEMA_SQL = TENANT_TABLES.map(policy).join("\n");

/**
 * Fail startup if any table carrying a `tenant_id`/`tenant` column has no RLS
 * policy (§13). Discovered from the catalog, not a hardcoded list, so a future
 * tenant-scoped table with no policy trips this rather than shipping unprotected.
 */
export async function assertTenantTablesProtected(sql: SqlClient): Promise<void> {
  // Scoped to the schema this connection resolves names in, not a hardcoded
  // 'public' — the engine may be deployed into a named schema, and the test
  // harness gives every test its own.
  const { rows } = await sql.query<{ table_name: string }>(
    `SELECT c.table_name
       FROM information_schema.columns c
       JOIN information_schema.tables t
         ON t.table_name = c.table_name AND t.table_schema = c.table_schema
      WHERE c.table_schema = current_schema()
        AND t.table_type = 'BASE TABLE'
        AND c.column_name IN ('tenant_id', 'tenant')
        AND c.table_name <> 'tenant'
        AND NOT EXISTS (
          SELECT 1 FROM pg_policies p
           WHERE p.schemaname = current_schema() AND p.tablename = c.table_name
        )
      GROUP BY c.table_name`,
  );
  if (rows.length > 0) {
    throw new Error(
      `Tenant-scoped tables without a row-level-security policy (build spec §13): ${rows
        .map((r) => r.table_name)
        .join(", ")}`,
    );
  }
}

export interface RlsEffectiveness {
  role: string;
  /** True when this role is exempt from every RLS policy, whatever the tables say. */
  bypasses: boolean;
  reason: string;
}

/**
 * Report whether row-level security actually constrains the CONNECTING ROLE.
 *
 * This is separate from `assertTenantTablesProtected` on purpose. That check asks
 * "do the tables carry policies?"; this one asks "does this connection obey
 * them?" — and the two can disagree completely. A role with `rolsuper` or
 * `rolbypassrls` skips every policy in the database, so the tables can be
 * ENABLEd, FORCEd, and fully policied while isolation does precisely nothing.
 *
 * Managed Postgres makes this the DEFAULT rather than an edge case: Neon's
 * `neondb_owner` ships with `rolbypassrls = true` (verified 2026-07). Connecting
 * the engine with that role silently disables §13. The engine must use a role
 * that has neither attribute.
 */
export async function checkRlsEffective(sql: SqlClient): Promise<RlsEffectiveness> {
  const { rows } = await sql.query<{
    role: string;
    rolsuper: boolean;
    rolbypassrls: boolean;
  }>(
    `SELECT current_user AS role, r.rolsuper, r.rolbypassrls
       FROM pg_roles r WHERE r.rolname = current_user`,
  );
  const row = rows[0];
  if (!row) return { role: "unknown", bypasses: false, reason: "could not read role attributes" };
  if (row.rolsuper) {
    return {
      role: row.role,
      bypasses: true,
      reason: "role is a SUPERUSER — bypasses all policies",
    };
  }
  if (row.rolbypassrls) {
    return { role: row.role, bypasses: true, reason: "role has BYPASSRLS — bypasses all policies" };
  }
  return { role: row.role, bypasses: false, reason: "role is subject to row-level security" };
}

/** Run `fn` scoped to a tenant: RLS then restricts every row it can see to that tenant. */
export async function withTenant<T>(
  sql: SqlClient,
  tenantId: string,
  fn: (tx: SqlClient) => Promise<T>,
): Promise<T> {
  return sql.transaction(async (tx) => {
    await tx.query("SELECT set_config('cixtech.tenant', $1, true)", [tenantId]);
    return fn(tx);
  });
}
