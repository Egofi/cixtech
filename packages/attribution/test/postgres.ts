import type { SqlClient } from "@cixtech/ledger";
import { type TestDatabase, freshDatabase } from "@cixtech/testing";
import { POOL_SCHEMA_SQL } from "../src/pool-store.js";

export async function freshPool(): Promise<{ db: TestDatabase; sql: SqlClient }> {
  const db = await freshDatabase();
  await db.exec(POOL_SCHEMA_SQL);
  return { db, sql: db.sql };
}

/** Deterministic fake deriver: distinct per (chain, xpub, index), as real derivation is. */
export const fakeDerive = (chain: string, xpub: string, index: number): string =>
  `${chain}:${xpub}:${index}`;
