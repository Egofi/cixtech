import { POOL_SCHEMA_SQL } from "@cixtech/attribution";
import { PAYOUT_JOURNAL_SCHEMA_SQL, POLICY_SCHEMA_SQL } from "@cixtech/chains";
import { LEDGER_SCHEMA_SQL } from "@cixtech/ledger";
import type { SqlClient } from "@cixtech/ledger";
import type { PGlite } from "@electric-sql/pglite";
import { ADMIN_SCHEMA_SQL } from "./admin/admin-schema.js";
import { API_SCHEMA_SQL } from "./api-schema.js";
import { CURSOR_SCHEMA_SQL } from "./chains/deposit-cursor.js";
import { RLS_SCHEMA_SQL, assertTenantTablesProtected } from "./rls.js";

/** Wraps a PGlite instance as the shared SqlClient. Prod swaps this for a pg/Prisma client. */
export function pgliteClient(db: PGlite): SqlClient {
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

/** Apply every schema the engine needs: ledger, address pool, and API tables. */
export async function applySchemas(db: PGlite): Promise<void> {
  await db.exec(LEDGER_SCHEMA_SQL);
  await db.exec(POOL_SCHEMA_SQL);
  await db.exec(POLICY_SCHEMA_SQL);
  await db.exec(PAYOUT_JOURNAL_SCHEMA_SQL);
  await db.exec(API_SCHEMA_SQL);
  await db.exec(ADMIN_SCHEMA_SQL);
  await db.exec(CURSOR_SCHEMA_SQL);
  await db.exec(RLS_SCHEMA_SQL);
  await assertTenantTablesProtected(pgliteClient(db));
}
