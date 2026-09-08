import pg from "pg";
import { type MigratableSqlClient, pgClient } from "./client.js";

const { Pool } = pg;

/**
 * Connection-string env vars, most-canonical first. `DATABASE_URL` is the name
 * egofi and Prisma already use (ADR 0013); `DB_URL` is accepted as an alias so a
 * plain `.env` works without renaming.
 */
const URL_VARS = ["DATABASE_URL", "CIXTECH_DATABASE_URL", "DB_URL"] as const;

/**
 * Direct (non-pooled) connection, used for DDL and migrations. ADR 0013: Neon
 * fronts `DATABASE_URL` with PgBouncer in *transaction* mode, where prepared
 * statements and session state do not survive — so migrations run against the
 * direct endpoint. Falls back to the pooled URL when unset.
 */
const DIRECT_URL_VARS = ["DIRECT_DATABASE_URL", "DIRECT_URL", "DIRECT_DB_URL"] as const;

export type Env = Record<string, string | undefined>;

const first = (env: Env, names: readonly string[]): string | undefined => {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return undefined;
};

export interface DatabaseUrls {
  /** Runtime connection string — pooled on Neon. */
  url: string;
  /** Direct, non-pooled connection for DDL/migrations. Equals `url` when not configured separately. */
  directUrl: string;
  /** True when `directUrl` came from its own env var rather than falling back. */
  hasDirect: boolean;
}

/** Resolve the configured Postgres URLs, or `undefined` when none is set. */
export function resolveDatabaseUrls(env: Env): DatabaseUrls | undefined {
  const url = first(env, URL_VARS);
  if (!url) return undefined;
  const direct = first(env, DIRECT_URL_VARS);
  return { url, directUrl: direct ?? url, hasDirect: direct !== undefined };
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", ""]);

/**
 * Redact a connection string down to what is safe to log: scheme, user, host,
 * and database. The password never reaches a log line or an error message.
 */
export function redactDatabaseUrl(url: string): string {
  try {
    const u = new URL(url);
    const user = u.username ? `${u.username}@` : "";
    return `${u.protocol}//${user}${u.host}${u.pathname}`;
  } catch {
    return "<unparseable connection string>";
  }
}

/**
 * TLS posture. Managed Postgres (Neon, RDS, CloudSQL) presents a publicly-trusted
 * certificate, so verification is ON by default for any non-local host — an
 * unverified TLS session to a custody database is a downgrade we never make
 * silently. `CIXTECH_DB_SSL` overrides: `disable` | `no-verify` | `require`.
 */
export function sslFor(url: string, env: Env): pg.PoolConfig["ssl"] {
  const mode = env["CIXTECH_DB_SSL"]?.trim().toLowerCase();
  if (mode === "disable") return false;
  if (mode === "no-verify") return { rejectUnauthorized: false };
  if (mode === "require") return { rejectUnauthorized: true };
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    /* fall through to the local default */
  }
  return LOCAL_HOSTS.has(host) ? false : { rejectUnauthorized: true };
}

/**
 * Drop TLS parameters from the connection string once we pass an explicit `ssl`
 * option. Two sources of truth for TLS is one too many for a custody database:
 * the explicit object wins anyway, and leaving `sslmode` in the URL only makes
 * the driver warn about semantics that no longer apply.
 */
export function stripSslParams(url: string): string {
  try {
    const u = new URL(url);
    for (const p of ["sslmode", "ssl", "channel_binding", "uselibpqcompat"]) {
      u.searchParams.delete(p);
    }
    return u.toString();
  } catch {
    return url;
  }
}

export interface Database {
  sql: MigratableSqlClient;
  /** What was connected to, safe to log (never contains the password). */
  describe: string;
  close(): Promise<void>;
}

export interface OpenDatabaseOptions {
  /** Use the direct (non-pooled) endpoint — for DDL and migrations (ADR 0013). */
  direct?: boolean;
  /** Max pooled connections. Keep modest: Neon counts connections against the compute. */
  maxConnections?: number;
  /** Bind every connection to a schema (`search_path`). Used by the test harness. */
  schema?: string;
}

export class DatabaseNotConfiguredError extends Error {
  constructor() {
    super(
      "No database URL configured. Set DATABASE_URL (or DB_URL) to a Postgres connection string.",
    );
    this.name = "DatabaseNotConfiguredError";
  }
}

/**
 * Values carried straight over from `.env.example`. Copying the template and
 * forgetting one line otherwise surfaces as an opaque DNS error, so name it.
 */
const PLACEHOLDER_MARKERS = ["ep-REPLACE", "ep-xxx", ":PASSWORD@", "://OWNER:", "user:pass@"];

export class DatabasePlaceholderUrlError extends Error {
  constructor(variable: string, url: string) {
    super(
      `${variable} still contains a placeholder from .env.example (${redactDatabaseUrl(
        url,
      )}). Replace it with your real connection string.`,
    );
    this.name = "DatabasePlaceholderUrlError";
  }
}

/** Throw if a configured URL is an unedited template value. */
export function assertNotPlaceholder(variable: string, url: string): void {
  if (PLACEHOLDER_MARKERS.some((m) => url.includes(m))) {
    throw new DatabasePlaceholderUrlError(variable, url);
  }
}

/** Open a pool against an explicit connection string. */
export function openDatabaseUrl(
  url: string,
  env: Env = {},
  opts: OpenDatabaseOptions = {},
): Database {
  const ssl = sslFor(url, env);
  const pool = new Pool({
    connectionString: ssl === false ? url : stripSslParams(url),
    ssl,
    ...(opts.maxConnections !== undefined ? { max: opts.maxConnections } : {}),
    // Applied per connection, so every pooled backend resolves unqualified names
    // in the same schema — the pool would otherwise hand back a default search_path.
    ...(opts.schema ? { options: `-c search_path=${opts.schema}` } : {}),
  });
  // Surface background pool errors instead of taking the process down.
  pool.on("error", (err) => console.error("[db] idle client error", err.message));
  return {
    sql: pgClient(pool),
    describe: redactDatabaseUrl(url),
    close: () => pool.end(),
  };
}

/**
 * Open the engine's database. Postgres is the only supported host (ADR 0013) —
 * there is no embedded fallback, so a misconfigured deployment fails loudly at
 * boot instead of quietly running on a database that cannot hold value.
 */
export function openDatabase(env: Env, opts: OpenDatabaseOptions = {}): Database {
  const urls = resolveDatabaseUrls(env);
  if (!urls) throw new DatabaseNotConfiguredError();
  const url = opts.direct ? urls.directUrl : urls.url;
  assertNotPlaceholder(opts.direct && urls.hasDirect ? "DIRECT_DATABASE_URL" : "DATABASE_URL", url);
  return openDatabaseUrl(url, env, opts);
}
