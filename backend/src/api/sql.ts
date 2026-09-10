import { createHash } from "node:crypto";
import type { AppliedSchema, SchemaModule, SqlClient, SqlResult } from "@/types";

import type { MigratableSqlClient } from "@/postgres";
import {
  ADMIN_SCHEMA_SQL,
  AI_SCHEMA_SQL,
  API_SCHEMA_SQL,
  AUTH_SCHEMA_SQL,
  BALANCE_CACHE_SCHEMA_SQL,
  CURSOR_SCHEMA_SQL,
  GATHER_CONFIG_SCHEMA_SQL,
  GATHER_LEASE_SCHEMA_SQL,
  LEDGER_SCHEMA_SQL,
  PAYOUT_APPROVAL_SCHEMA_SQL,
  PAYOUT_JOURNAL_SCHEMA_SQL,
  POLICY_SCHEMA_SQL,
  POOL_SCHEMA_SQL,
} from "@/schemas/sql";
import { RLS_SCHEMA_SQL, assertTenantTablesProtected } from "./rls.js";

export type { MigratableSqlClient };

const MIGRATION_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS schema_migration (
  name       text PRIMARY KEY,
  checksum   text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz
);
`;

export const SCHEMA_MODULES: readonly SchemaModule[] = [
  { name: "ledger", sql: LEDGER_SCHEMA_SQL },
  { name: "pool", sql: POOL_SCHEMA_SQL },
  { name: "gather-config", sql: GATHER_CONFIG_SCHEMA_SQL },
  { name: "pool-balance-cache", sql: BALANCE_CACHE_SCHEMA_SQL },
  { name: "gather-lease", sql: GATHER_LEASE_SCHEMA_SQL },
  { name: "policy", sql: POLICY_SCHEMA_SQL },
  { name: "payout-journal", sql: PAYOUT_JOURNAL_SCHEMA_SQL },
  { name: "payout-approval", sql: PAYOUT_APPROVAL_SCHEMA_SQL },
  { name: "api", sql: API_SCHEMA_SQL },

  { name: "auth", sql: AUTH_SCHEMA_SQL },
  { name: "admin", sql: ADMIN_SCHEMA_SQL },
  { name: "deposit-cursor", sql: CURSOR_SCHEMA_SQL },
  { name: "ai", sql: AI_SCHEMA_SQL },
  { name: "rls", sql: RLS_SCHEMA_SQL },
];

const checksum = (sql: string): string =>
  createHash("sha256").update(sql).digest("hex").slice(0, 16);

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

  await assertTenantTablesProtected(sql);
  return applied;
}

export async function assertSchemaReady(sql: SqlClient): Promise<void> {
  let present: SqlResult<{ name: string; checksum: string }>;
  try {
    present = await sql.query<{ name: string; checksum: string }>(
      "SELECT name, checksum FROM schema_migration",
    );
  } catch (err) {
    // Only an existing, reachable database can be missing a table. Anything else
    // — refused connection, bad credentials, wrong host — is a different problem,
    // and reporting it as "run db:migrate" sends the reader somewhere that will
    // fail in exactly the same way.
    const code = (err as { code?: string }).code;
    if (code === "42P01") {
      throw new Error(
        "Database has no schema_migration table — run `pnpm db:migrate` before starting the engine.",
      );
    }
    throw new Error(
      `Cannot reach the database to check its schema (${code ?? "unknown error"}): ${
        err instanceof Error ? err.message : String(err)
      }`,
      { cause: err },
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
