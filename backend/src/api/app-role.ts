import { randomBytes } from "node:crypto";
import type { MigratableSqlClient } from "@/postgres";
import type { AppRole } from "@/types";

const APPEND_ONLY_TABLES = ["journal_entry", "posting", "admin_audit", "error_log"] as const;

const quoteIdent = (name: string): string => `"${name.replace(/"/g, '""')}"`;
const quoteLiteral = (value: string): string => `'${value.replace(/'/g, "''")}'`;

const VALID_ROLE = /^[a-z_][a-z0-9_]{0,62}$/;

export async function provisionAppRole(
  sql: MigratableSqlClient,
  name: string,
  opts: { password?: string } = {},
): Promise<AppRole> {
  if (!VALID_ROLE.test(name)) {
    throw new Error(
      `Invalid role name ${JSON.stringify(name)} — use lower-case letters, digits and underscores.`,
    );
  }
  const role = quoteIdent(name);

  const { rows } = await sql.query<{ exists: boolean }>(
    "SELECT true AS exists FROM pg_roles WHERE rolname = $1",
    [name],
  );
  const existed = rows.length > 0;

  const password = opts.password ?? randomBytes(24).toString("base64url");
  if (!existed) {
    await sql.exec(
      `CREATE ROLE ${role} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE
         PASSWORD ${quoteLiteral(password)};`,
    );
  } else {
    await sql.exec(`ALTER ROLE ${role} NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;`);
  }

  const appendOnly = APPEND_ONLY_TABLES.map(quoteIdent).join(", ");

  const { rows: schemaRows } = await sql.query<{ schema: string }>(
    "SELECT current_schema() AS schema",
  );
  const schema = quoteIdent(schemaRows[0]?.schema ?? "public");
  await sql.exec(`
GRANT USAGE ON SCHEMA ${schema} TO ${role};
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${schema} TO ${role};
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${schema} TO ${role};

-- ADR 0010: the financial and audit trails are append-only. Revoke the mutating
-- rights the blanket grant above just handed out.
REVOKE UPDATE, DELETE ON ${appendOnly} FROM ${role};

-- Tables created by a future migration inherit the same baseline.
ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema}
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${role};
ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema}
  GRANT USAGE, SELECT ON SEQUENCES TO ${role};
`);

  return existed ? { name, created: false } : { name, password, created: true };
}

export function connectionStringFor(base: string, role: string, password: string): string {
  const u = new URL(base);
  u.username = encodeURIComponent(role);
  u.password = encodeURIComponent(password);
  return u.toString();
}
