import type { SqlClient } from "@/types";
import type pg from "pg";

/**
 * A `SqlClient` that can also run multi-statement DDL. Schema application needs
 * the simple-query protocol (many statements, no parameters), which the
 * parameterized `query` path deliberately does not expose.
 */
export interface MigratableSqlClient extends SqlClient {
  exec(sql: string): Promise<void>;
}

/**
 * Wrap a `pg.Pool` as the shared `SqlClient` (ADR 0013 — the port that keeps the
 * ledger host swappable).
 *
 * `transaction` checks out ONE connection and runs the whole unit of work on it,
 * which is what makes `SqlLedgerStore.append` atomic on a pooled database: without
 * it, each statement could land on a different backend and the entry/postings/
 * balance writes would not share a transaction. A nested `transaction` becomes a
 * SAVEPOINT rather than a second `BEGIN` (which Postgres would warn about and
 * whose COMMIT would wrongly commit the outer transaction).
 */
export function pgClient(pool: pg.Pool): MigratableSqlClient {
  const onClient = (client: pg.PoolClient, depth: number): SqlClient => ({
    async query<R>(text: string, params?: readonly unknown[]) {
      const r = await client.query(text, params ? [...params] : undefined);
      return { rows: r.rows as R[] };
    },
    async transaction<T>(fn: (tx: SqlClient) => Promise<T>) {
      const savepoint = `cixtech_sp_${depth}`;
      await client.query(`SAVEPOINT ${savepoint}`);
      try {
        const out = await fn(onClient(client, depth + 1));
        await client.query(`RELEASE SAVEPOINT ${savepoint}`);
        return out;
      } catch (err) {
        await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        throw err;
      }
    },
  });

  return {
    async query<R>(text: string, params?: readonly unknown[]) {
      const r = await pool.query(text, params ? [...params] : undefined);
      return { rows: r.rows as R[] };
    },
    async transaction<T>(fn: (tx: SqlClient) => Promise<T>) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const out = await fn(onClient(client, 0));
        await client.query("COMMIT");
        return out;
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    async exec(sql: string) {
      // No parameters → simple-query protocol, which accepts multiple statements
      // in one round trip. This is the DDL path; never used for tenant data.
      await pool.query(sql);
    },
  };
}
