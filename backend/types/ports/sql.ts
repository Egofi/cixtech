export interface SqlResult<R> {
  rows: R[];
}

export interface SqlClient {
  query<R = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ): Promise<SqlResult<R>>;

  transaction<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T>;
}
