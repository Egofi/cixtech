import { createHash } from "node:crypto";
import { GATHER_CONFIG_SCHEMA_SQL, POOL_SCHEMA_SQL } from "@cixtech/attribution";
import {
  PAYOUT_APPROVAL_SCHEMA_SQL,
  PAYOUT_JOURNAL_SCHEMA_SQL,
  POLICY_SCHEMA_SQL,
} from "@cixtech/chains";
import { LEDGER_SCHEMA_SQL } from "@cixtech/ledger";
import type { SqlClient } from "@cixtech/ledger";
import type { MigratableSqlClient } from "@cixtech/postgres";
import { ADMIN_SCHEMA_SQL } from "./admin/admin-schema.js";
import { API_SCHEMA_SQL } from "./api-schema.js";
import { CURSOR_SCHEMA_SQL } from "./chains/deposit-cursor.js";
import { RLS_SCHEMA_SQL, assertTenantTablesProtected } from "./rls.js";

export type { MigratableSqlClient };

/** The migration bookkeeping table — applied before anything it records. */
const MIGRATION_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS schema_migration (
  name       text PRIMARY KEY,
  checksum   text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz
);
`;

export interface SchemaModule {
  name: string;
  sql: string;
}

/**
 * Every schema the engine needs, in dependency order. RLS is last: its policies
 * attach to tables the preceding modules create.
 */
export const SCHEMA_MODULES: readonly SchemaModule[] = [
  { name: "ledger", sql: LEDGER_SCHEMA_SQL },
  { name: "pool", sql: POOL_SCHEMA_SQL },
  { name: "gather-config", sql: GATHER_CONFIG_SCHEMA_SQL },
  { name: "policy", sql: POLICY_SCHEMA_SQL },
  { name: "payout-journal", sql: PAYOUT_JOURNAL_SCHEMA_SQL },
  { name: "payout-approval", sql: PAYOUT_APPROVAL_SCHEMA_SQL },
  { name: "api", sql: API_SCHEMA_SQL },
  { name: "admin", sql: ADMIN_SCHEMA_SQL },
  { name: "deposit-cursor", sql: CURSOR_SCHEMA_SQL },
  { name: "rls", sql: RLS_SCHEMA_SQL },
];

const checksum = (sql: string): string =>
  createHash("sha256").update(sql).digest("hex").slice(0, 16);

export type SchemaStatus =
  /** First time this module has been applied to this database. */
  | "created"
  /** Already applied and byte-identical to what is in the code. */
  | "unchanged"
  /**
   * Applied before, but the module's SQL has since changed. Every statement is
   * `IF NOT EXISTS`, so re-running it does NOT alter tables that already exist —
   * a column added to the module will be missing here. Needs a real ALTER.
   */
  | "changed";

export interface AppliedSchema {
  name: string;
  status: SchemaStatus;
}

/**
 * Apply every schema module and record what was applied (build spec §13).
 * Idempotent: each module is `CREATE ... IF NOT EXISTS`, so re-running is safe.
 *
 * The recorded checksum is what makes drift *visible*: because the DDL cannot
 * alter an existing table, a module whose SQL changed after it was first applied
 * is reported as `changed` rather than being silently treated as up to date.
 */
export async function applySchemas(sql: MigratableSqlClient): Promise<AppliedSchema[]> {
  await sql.exec(MIGRATION_SCHEMA_SQL);

  const { rows } = await sql.query<{ name: string; checksum: string }>(
    "SELECT name, checksum FROM schema_migration",
  );
  const recorded = new Map(rows.map((r) => [r.name, r.checksum]));

  const applied: AppliedSchema[] = [];
  for (const mod of SCHEMA_MODULES) {
    const sum = checksum(mod.sql);
    const previous = recorded.get(mod.name);
    await sql.exec(mod.sql);
    await sql.query(
      `INSERT INTO schema_migration (name, checksum)
       VALUES ($1, $2)
       ON CONFLICT (name) DO UPDATE SET checksum = EXCLUDED.checksum, updated_at = now()`,
      [mod.name, sum],
    );
    applied.push({
      name: mod.name,
      status: previous === undefined ? "created" : previous === sum ? "unchanged" : "changed",
    });
  }

  // §13 boot guard: a tenant-scoped table with no RLS policy fails here.
  await assertTenantTablesProtected(sql);
  return applied;
}

/**
 * Assert the database already carries every schema module, without issuing DDL.
 *
 * The server calls this against managed Postgres so a production process never
 * silently mutates the schema of a custody database on boot — migrations are a
 * deliberate, auditable command (`pnpm db:migrate`), not a start-up side effect.
 */
export async function assertSchemaReady(sql: SqlClient): Promise<void> {
  const present = await sql
    .query<{ name: string; checksum: string }>("SELECT name, checksum FROM schema_migration")
    .catch(() => null);
  if (!present) {
    throw new Error(
      "Database has no schema_migration table — run `pnpm db:migrate` before starting the engine.",
    );
  }
  const recorded = new Map(present.rows.map((r) => [r.name, r.checksum]));
  const missing = SCHEMA_MODULES.filter((m) => !recorded.has(m.name)).map((m) => m.name);
  if (missing.length > 0) {
    throw new Error(
      `Database is missing schema modules [${missing.join(", ")}] — run \`pnpm db:migrate\`.`,
    );
  }
  const stale = SCHEMA_MODULES.filter((m) => recorded.get(m.name) !== checksum(m.sql)).map(
    (m) => m.name,
  );
  if (stale.length > 0) {
    throw new Error(
      `Schema modules [${stale.join(", ")}] changed since they were applied — run \`pnpm db:migrate\`.`,
    );
  }
  await assertTenantTablesProtected(sql);
}
