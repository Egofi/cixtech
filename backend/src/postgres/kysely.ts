import type { DB, SqlClient } from "@/types";
import {
  type CompiledQuery,
  type DatabaseConnection,
  type DatabaseIntrospector,
  type Dialect,
  type Driver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type QueryResult,
} from "kysely";

const TRANSACTIONS_ARE_NOT_OURS =
  "Kysely transactions are disabled here. Transactions belong to SqlClient so that " +
  "tenant scoping still binds the cixtech.tenant GUC: use sql.transaction((tx) => ... kyselyFor(tx)).";

class SqlClientConnection implements DatabaseConnection {
  constructor(private readonly sql: SqlClient) {}

  async executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
    const { rows } = await this.sql.query<R>(compiled.sql, compiled.parameters);
    return { rows };
  }

  streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
    throw new Error("Streaming is not supported by the SqlClient-backed Kysely driver.");
  }
}

class SqlClientDriver implements Driver {
  constructor(private readonly sql: SqlClient) {}

  async init(): Promise<void> {}

  async acquireConnection(): Promise<DatabaseConnection> {
    return new SqlClientConnection(this.sql);
  }

  async beginTransaction(): Promise<void> {
    throw new Error(TRANSACTIONS_ARE_NOT_OURS);
  }

  async commitTransaction(): Promise<void> {
    throw new Error(TRANSACTIONS_ARE_NOT_OURS);
  }

  async rollbackTransaction(): Promise<void> {
    throw new Error(TRANSACTIONS_ARE_NOT_OURS);
  }

  async releaseConnection(): Promise<void> {}

  async destroy(): Promise<void> {}
}

const dialectFor = (sql: SqlClient): Dialect => ({
  createAdapter: () => new PostgresAdapter(),
  createDriver: () => new SqlClientDriver(sql),
  createIntrospector: (db: Kysely<unknown>): DatabaseIntrospector => new PostgresIntrospector(db),
  createQueryCompiler: () => new PostgresQueryCompiler(),
});

export const kyselyFor = (sql: SqlClient): Kysely<DB> =>
  new Kysely<DB>({ dialect: dialectFor(sql) });
