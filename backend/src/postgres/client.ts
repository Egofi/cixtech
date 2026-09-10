import type { SqlClient } from "@/types";
import type pg from "pg";

export interface MigratableSqlClient extends SqlClient {
  exec(sql: string): Promise<void>;
}

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
      await pool.query(sql);
    },
  };
}
