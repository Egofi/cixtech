import type { SqlClient } from "@cixtech/ledger";
import { PGlite } from "@electric-sql/pglite";
import { POOL_SCHEMA_SQL } from "../src/pool-store.js";

function wrap(db: PGlite): SqlClient {
  const w = (q: { query: PGlite["query"]; transaction: PGlite["transaction"] }): SqlClient => ({
    async query<R>(text: string, params?: readonly unknown[]) {
      const r = await q.query(text, params ? [...params] : []);
      return { rows: r.rows as R[] };
    },
    async transaction<T>(fn: (tx: SqlClient) => Promise<T>) {
      return q.transaction((tx) => fn(w(tx as unknown as typeof q)));
    },
  });
  return w(db);
}

export async function freshPool(): Promise<{ db: PGlite; sql: SqlClient }> {
  const db = new PGlite();
  await db.exec(POOL_SCHEMA_SQL);
  return { db, sql: wrap(db) };
}

/** Deterministic fake deriver: distinct per (chain, xpub, index), as real derivation is. */
export const fakeDerive = (chain: string, xpub: string, index: number): string =>
  `${chain}:${xpub}:${index}`;
