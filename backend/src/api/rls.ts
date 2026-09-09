import type { RlsEffectiveness, SqlClient } from "@/types";

interface TenantTable {
  table: string;
  column: "tenant_id" | "tenant";

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

  { table: "principal", column: "tenant_id" },

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

export async function assertTenantTablesProtected(sql: SqlClient): Promise<void> {
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
