import { LEDGER_SCHEMA_SQL, SqlLedgerStore } from "@/ledger/index.js";
import type { SqlClient } from "@/ledger/sql/sql-client.js";
import { type TestDatabase, freshDatabase, truncateAll } from "@test/support/index.js";

/**
 * Ledger persistence properties run against a REAL PostgreSQL server (see
 * `@cixtech/testing`), each test isolated in its own schema. Real Postgres is what
 * makes the concurrency property meaningful: `append` claims one pooled connection
 * per transaction, so genuinely parallel writers race here the way they will in
 * production. An in-process single-connection database would serialize them and
 * the property would pass without proving anything.
 */
export interface Harness {
  db: TestDatabase;
  sql: SqlClient;
  store: SqlLedgerStore;
}

export async function freshStore(): Promise<Harness> {
  // Shared across the file's tests via beforeAll, so it opts out of per-test cleanup.
  const db = await freshDatabase(LEDGER_SCHEMA_SQL, { autoClose: false });
  return { db, sql: db.sql, store: new SqlLedgerStore(db.sql) };
}

/**
 * Clear all ledger state without re-creating the schema — call at the top of each
 * property iteration so one `freshStore()` (created in `beforeAll`) is reused
 * instead of paying schema setup on every run.
 */
export async function reset(h: Harness): Promise<void> {
  await truncateAll(h.sql, h.db.schema);
}

export async function close(h: Harness): Promise<void> {
  await h.db.close();
}
