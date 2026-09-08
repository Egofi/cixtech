export interface SqlResult<R> {
  rows: R[];
}

/**
 * Minimal SQL executor the persistence layer targets, so every store is
 * host-agnostic (ADR 0013). It lives here — in the dependency-free types package
 * — rather than beside the ledger, so a driver adapter (`@cixtech/postgres`) can
 * implement the port without depending on the domain package that consumes it.
 */
export interface SqlClient {
  query<R = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ): Promise<SqlResult<R>>;
  /** Runs `fn` in a single transaction; commits on resolve, rolls back on throw. */
  transaction<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T>;
}
