import { LEDGER_SCHEMA_SQL } from "@/schemas/sql";
import { SqlLedgerStore } from "@/stores";
import type { SqlClient } from "@/types";

import { type TestDatabase, freshDatabase, truncateAll } from "@test/support/index.js";

export interface Harness {
  db: TestDatabase;
  sql: SqlClient;
  store: SqlLedgerStore;
}

export async function freshStore(): Promise<Harness> {
  const db = await freshDatabase(LEDGER_SCHEMA_SQL, { autoClose: false });
  return { db, sql: db.sql, store: new SqlLedgerStore(db.sql) };
}

export async function reset(h: Harness): Promise<void> {
  await truncateAll(h.sql, h.db.schema);
}

export async function close(h: Harness): Promise<void> {
  await h.db.close();
}
