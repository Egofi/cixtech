export interface SqlResult<R> {
  rows: R[];
}

/**
 * Minimal SQL executor the persistence layer targets, so the ledger store is
 * host-agnostic: PGlite backs the tests (real Postgres, in-process), a Prisma /
 * node-postgres client backs production (ADR 0013). The `LedgerStore` port stays
 * free of any concrete driver.
 */
export interface SqlClient {
  query<R = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ): Promise<SqlResult<R>>;
  /** Runs `fn` in a single transaction; commits on resolve, rolls back on throw. */
  transaction<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T>;
}
