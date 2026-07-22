import type { SqlClient } from "@cixtech/ledger";

/**
 * Row-level security for every tenant-scoped table (build spec §13). Each table
 * that carries a tenant column gets RLS enabled and a policy keyed on the
 * `cixtech.tenant` GUC: a request that runs inside `withTenant` sees only its own
 * rows; an unset GUC (the trusted owner / cross-tenant admin plane) is unrestricted.
 * This is defense-in-depth beneath the query-level tenant scoping already enforced.
 *
 * The boot-time guard (`assertTenantTablesProtected`) then FAILS STARTUP if any
 * table with a tenant column lacks a policy — so a new tenant-scoped table can
 * never ship without isolation, exactly as §13 requires.
 */
interface TenantTable {
  table: string;
  column: "tenant_id" | "tenant";
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
];

const policy = (t: TenantTable): string => `
ALTER TABLE ${t.table} ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ${t.table}_tenant_isolation ON ${t.table};
CREATE POLICY ${t.table}_tenant_isolation ON ${t.table}
  USING (
    current_setting('cixtech.tenant', true) IS NULL
    OR current_setting('cixtech.tenant', true) = ''
    OR ${t.column} = current_setting('cixtech.tenant', true)
  );
`;

export const RLS_SCHEMA_SQL = TENANT_TABLES.map(policy).join("\n");

/**
 * Fail startup if any table carrying a `tenant_id`/`tenant` column has no RLS
 * policy (§13). Discovered from the catalog, not a hardcoded list, so a future
 * tenant-scoped table with no policy trips this rather than shipping unprotected.
 */
export async function assertTenantTablesProtected(sql: SqlClient): Promise<void> {
  const { rows } = await sql.query<{ table_name: string }>(
    `SELECT c.table_name
       FROM information_schema.columns c
       JOIN information_schema.tables t
         ON t.table_name = c.table_name AND t.table_schema = c.table_schema
      WHERE c.table_schema = 'public'
        AND t.table_type = 'BASE TABLE'
        AND c.column_name IN ('tenant_id', 'tenant')
        AND c.table_name <> 'tenant'
        AND NOT EXISTS (
          SELECT 1 FROM pg_policies p
           WHERE p.schemaname = 'public' AND p.tablename = c.table_name
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
