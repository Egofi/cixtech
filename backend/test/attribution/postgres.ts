import { POOL_SCHEMA_SQL } from "@/attribution/pool-store.js";
import type { SqlClient } from "@/ledger";
import { type TestDatabase, freshDatabase } from "@test/support/index.js";

export async function freshPool(): Promise<{ db: TestDatabase; sql: SqlClient }> {
  const db = await freshDatabase();
  await db.exec(POOL_SCHEMA_SQL);
  return { db, sql: db.sql };
}

/** Deterministic fake deriver: distinct per (chain, xpub, index), as real derivation is. */
export const fakeDerive = (chain: string, xpub: string, index: number): string =>
  `${chain}:${xpub}:${index}`;
