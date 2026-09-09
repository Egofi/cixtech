import { POOL_SCHEMA_SQL } from "@/schemas/sql";
import type { SqlClient } from "@/types";

import { type TestDatabase, freshDatabase } from "@test/support/index.js";

export async function freshPool(): Promise<{ db: TestDatabase; sql: SqlClient }> {
  const db = await freshDatabase();
  await db.exec(POOL_SCHEMA_SQL);
  return { db, sql: db.sql };
}

export const fakeDerive = (chain: string, xpub: string, index: number): string =>
  `${chain}:${xpub}:${index}`;
