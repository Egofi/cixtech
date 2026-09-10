import { randomUUID } from "node:crypto";
import { type Database, type MigratableSqlClient, openDatabaseUrl } from "@/postgres";
import type { SqlClient } from "@/types";
import { TEST_PG_URL_ENV } from "./global-setup.js";

export interface TestDatabase extends Database {
  schema: string;
  sql: MigratableSqlClient;

  exec(sql: string): Promise<void>;

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

const openHandles = new Set<TestDatabase>();

export async function closeOpenDatabases(): Promise<void> {
  const handles = [...openHandles];
  openHandles.clear();
  for (const h of handles) await h.close().catch(() => {});
}

export interface FreshDatabaseOptions {
  autoClose?: boolean;

  maxConnections?: number;
}

export async function freshDatabase(
  setupSql?: string,
  options: FreshDatabaseOptions = {},
): Promise<TestDatabase> {
  const url = serverUrl();
  const schema = schemaName();

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

export async function truncateAll(sql: SqlClient, schema: string): Promise<void> {
  const { rows } = await sql.query<{ tables: string | null }>(
    `SELECT string_agg(quote_ident(tablename), ', ') AS tables
       FROM pg_tables WHERE schemaname = $1`,
    [schema],
  );
  const tables = rows[0]?.tables;
  if (tables) await sql.query(`TRUNCATE ${tables} RESTART IDENTITY CASCADE`);
}
