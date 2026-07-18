import { PGlite } from "@electric-sql/pglite";
import { LEDGER_SCHEMA_SQL, SqlLedgerStore } from "../src/index.js";
import type { SqlClient } from "../src/sql/sql-client.js";

// PGlite is real Postgres compiled to WASM — genuine SQL, constraints, and
// transactions, in-process and Docker-free. True multi-connection parallelism
// (a real thread race) is verified separately in CI with testcontainers; here we
// verify the SQL is correct and enforces its invariants.
type PGliteQueryable = {
  query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
  transaction: <T>(fn: (tx: PGliteQueryable) => Promise<T>) => Promise<T>;
};

function wrap(db: PGliteQueryable): SqlClient {
  return {
    async query<R>(text: string, params?: readonly unknown[]) {
      const r = await db.query(text, params ? [...params] : []);
      return { rows: r.rows as R[] };
    },
    async transaction<T>(fn: (tx: SqlClient) => Promise<T>) {
      return db.transaction((tx) => fn(wrap(tx)));
    },
  };
}

export interface Harness {
  db: PGlite;
  sql: SqlClient;
  store: SqlLedgerStore;
}

export async function freshStore(): Promise<Harness> {
  const db = new PGlite();
  await db.exec(LEDGER_SCHEMA_SQL);
  const sql = wrap(db as unknown as PGliteQueryable);
  return { db, sql, store: new SqlLedgerStore(sql) };
}

/**
 * Clear all ledger state without re-booting the WASM instance — call at the top
 * of each property iteration so one `freshStore()` (created in `beforeAll`) can be
 * reused, instead of paying the PGlite boot cost on every run.
 */
export async function reset(h: Harness): Promise<void> {
  await h.db.exec("TRUNCATE journal_entry, posting, balance RESTART IDENTITY CASCADE;");
}
