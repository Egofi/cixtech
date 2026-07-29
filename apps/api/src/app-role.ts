import { randomBytes } from "node:crypto";
import type { MigratableSqlClient } from "@cixtech/postgres";

/**
 * Provision the least-privileged database role the engine connects as.
 *
 * Two controls that only exist at the database level, and only for a role that is
 * NOT the table owner and NOT exempt from RLS:
 *
 * 1. **Tenant isolation actually applies.** A `BYPASSRLS`/superuser role — which
 *    is what managed Postgres hands you by default (Neon's `neondb_owner`) —
 *    ignores every policy in the database, so §13 becomes decorative. The app
 *    role is created with `NOBYPASSRLS`.
 * 2. **The ledger is append-only in the engine, not merely by convention.** ADR
 *    0010 says postings are immutable and corrections are reversing entries.
 *    Granting only SELECT/INSERT on the financial and audit trails means a bug —
 *    or a compromised API process — *cannot* issue an UPDATE or DELETE against
 *    them. The migration role retains full rights for schema work.
 */

/** Trails that must never be mutated in place: SELECT + INSERT only. */
const APPEND_ONLY_TABLES = ["journal_entry", "posting", "admin_audit", "error_log"] as const;

/** Postgres identifier quoting — the role name reaches DDL that cannot be parameterized. */
const quoteIdent = (name: string): string => `"${name.replace(/"/g, '""')}"`;
const quoteLiteral = (value: string): string => `'${value.replace(/'/g, "''")}'`;

const VALID_ROLE = /^[a-z_][a-z0-9_]{0,62}$/;

export interface AppRole {
  name: string;
  /** Generated only when the role was created; `undefined` when it already existed. */
  password?: string;
  created: boolean;
}

/**
 * Create (or update the grants of) the engine's application role.
 *
 * Idempotent: an existing role keeps its password and only has its grants
 * refreshed, so re-running the migration never invalidates a deployed connection
 * string.
 */
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

  // 24 bytes base64url — no shell-hostile or URL-escaping characters.
  const password = opts.password ?? randomBytes(24).toString("base64url");
  if (!existed) {
    await sql.exec(
      `CREATE ROLE ${role} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE
         PASSWORD ${quoteLiteral(password)};`,
    );
  } else {
    // Never silently rotate a live credential; do enforce the security attributes.
    await sql.exec(`ALTER ROLE ${role} NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;`);
  }

  const appendOnly = APPEND_ONLY_TABLES.map(quoteIdent).join(", ");
  // Grants target the schema this connection resolves names in, so the engine can
  // be deployed into a named schema rather than assuming `public`.
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

/** Rewrite a connection string to use a different role + password, preserving everything else. */
export function connectionStringFor(base: string, role: string, password: string): string {
  const u = new URL(base);
  u.username = encodeURIComponent(role);
  u.password = encodeURIComponent(password);
  return u.toString();
}
