import { randomUUID } from "node:crypto";
import { type Database, type MigratableSqlClient, openDatabaseUrl } from "@/postgres";
import type { SqlClient } from "@/types";
import { TEST_PG_URL_ENV } from "./global-setup.js";

/**
 * An isolated database for one test, backed by a private schema on the shared
 * test server. Schema-per-test rather than database-per-test because `CREATE
 * SCHEMA` costs well under a millisecond while `CREATE DATABASE` copies a
 * template; with hundreds of call sites that difference dominates the suite.
 */
export interface TestDatabase extends Database {
  /** The private schema every connection in this handle is bound to. */
  schema: string;
  sql: MigratableSqlClient;
  /** Run multi-statement DDL in this schema. */
  exec(sql: string): Promise<void>;
  /**
   * A second handle on the same schema, connected as a role that row-level
   * security actually applies to — `NOBYPASSRLS`, not the owner. The default
   * handle is the owner and therefore bypasses RLS, exactly as Neon's
   * `neondb_owner` does (ADR 0013).
   */
  asAppRole(): Promise<Database>;
}

function serverUrl(): string {
  const url = process.env[TEST_PG_URL_ENV];
  if (!url) {
    throw new Error(
      `${TEST_PG_URL_ENV} is not set — add packages/testing/src/global-setup.ts to this package's vitest \`globalSetup\`.`,
    );
  }
  return url;
}

const schemaName = (): string => `t_${randomUUID().replace(/-/g, "")}`;

/**
 * Every auto-closing handle created since the last sweep. A test that forgets to
 * close would otherwise hold its pool open for the whole run, and Postgres caps
 * concurrent connections — a leak shows up as an unrelated test failing to
 * connect, which is a miserable thing to debug.
 */
const openHandles = new Set<TestDatabase>();

/** Close every auto-closing handle. Wired into `afterEach` by `setup.ts`. */
export async function closeOpenDatabases(): Promise<void> {
  const handles = [...openHandles];
  openHandles.clear();
  for (const h of handles) await h.close().catch(() => {});
}

export interface FreshDatabaseOptions {
  /**
   * Close automatically at the end of the current test (default). Set false for a
   * handle created in `beforeAll` and shared across a file's tests — it must then
   * be closed explicitly in `afterAll`.
   */
  autoClose?: boolean;
  /** Pool size. Deliberately small: many handles are alive at once across parallel files. */
  maxConnections?: number;
}

/**
 * Create an isolated schema and return a client bound to it. `setupSql` (a
 * package's schema DDL) is applied inside that schema, so unqualified table names
 * in production code resolve there with no changes.
 */
export async function freshDatabase(
  setupSql?: string,
  options: FreshDatabaseOptions = {},
): Promise<TestDatabase> {
  const url = serverUrl();
  const schema = schemaName();

  // Create the schema on a connection that is not yet bound to it.
  const bootstrap = openDatabaseUrl(url, {}, { maxConnections: 1 });
  try {
    await bootstrap.sql.exec(`CREATE SCHEMA ${schema};`);
  } finally {
    await bootstrap.close();
  }

  const db = openDatabaseUrl(url, {}, { schema, maxConnections: options.maxConnections ?? 4 });
  if (setupSql) await db.sql.exec(setupSql);

  const extra: Database[] = [];
  const handle: TestDatabase = {
    ...db,
    schema,
    exec: (sql: string) => db.sql.exec(sql),
    async asAppRole(): Promise<Database> {
      const role = `app_${schema}`;
      await db.sql.exec(`
CREATE ROLE ${role} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD 'app';
GRANT USAGE ON SCHEMA ${schema} TO ${role};
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${schema} TO ${role};
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${schema} TO ${role};
`);
      const asRole = new URL(url);
      asRole.username = role;
      asRole.password = "app";
      const handle = openDatabaseUrl(asRole.toString(), {}, { schema, maxConnections: 4 });
      extra.push(handle);
      return handle;
    },
    async close(): Promise<void> {
      openHandles.delete(handle);
      for (const h of extra) await h.close().catch(() => {});
      await db.close();
      // Drop the schema from a fresh connection — the pool above is now closed.
      const cleanup = openDatabaseUrl(url, {}, { maxConnections: 1 });
      try {
        await cleanup.sql.exec(`DROP OWNED BY app_${schema};`).catch(() => {});
        await cleanup.sql.exec(`DROP ROLE IF EXISTS app_${schema};`).catch(() => {});
        await cleanup.sql.exec(`DROP SCHEMA IF EXISTS ${schema} CASCADE;`);
      } finally {
        await cleanup.close();
      }
    },
  };
  if (options.autoClose !== false) openHandles.add(handle);
  return handle;
}

/** Truncate every table in the schema — cheaper than a new schema per property iteration. */
export async function truncateAll(sql: SqlClient, schema: string): Promise<void> {
  const { rows } = await sql.query<{ tables: string | null }>(
    `SELECT string_agg(quote_ident(tablename), ', ') AS tables
       FROM pg_tables WHERE schemaname = $1`,
    [schema],
  );
  const tables = rows[0]?.tables;
  if (tables) await sql.query(`TRUNCATE ${tables} RESTART IDENTITY CASCADE`);
}
