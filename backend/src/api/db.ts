/**
 * The engine's database access lives in `@cixtech/postgres` so the app, the
 * migration command, and the test harness all share one adapter (ADR 0013).
 * Postgres is the only supported host — there is no embedded fallback, so a
 * misconfigured deployment fails loudly rather than quietly running on a database
 * that cannot hold value.
 */
export {
  type Database,
  DatabaseNotConfiguredError,
  type DatabaseUrls,
  type Env,
  type MigratableSqlClient,
  type OpenDatabaseOptions,
  openDatabase,
  openDatabaseUrl,
  pgClient,
  redactDatabaseUrl,
  resolveDatabaseUrls,
} from "@/postgres";
