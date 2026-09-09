import { DatabaseNotConfiguredError, DatabasePlaceholderUrlError } from "@/common";
import { type MigratableSqlClient, pgClient } from "@/postgres";
import type { DatabaseUrls, Env, OpenDatabaseOptions } from "@/types";
import pg from "pg";

const { Pool } = pg;
const URL_VARS = ["DATABASE_URL", "CIXTECH_DATABASE_URL", "DB_URL"] as const;
const DIRECT_URL_VARS = ["DIRECT_DATABASE_URL", "DIRECT_URL", "DIRECT_DB_URL"] as const;

const first = (env: Env, names: readonly string[]): string | undefined => {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return undefined;
};

export function resolveDatabaseUrls(env: Env): DatabaseUrls | undefined {
  const url = first(env, URL_VARS);
  if (!url) return undefined;
  const direct = first(env, DIRECT_URL_VARS);
  return { url, directUrl: direct ?? url, hasDirect: direct !== undefined };
}
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", ""]);
export function redactDatabaseUrl(url: string): string {
  try {
    const u = new URL(url);
    const user = u.username ? `${u.username}@` : "";
    return `${u.protocol}//${user}${u.host}${u.pathname}`;
  } catch {
    return "<unparseable connection string>";
  }
}
export function sslFor(url: string, env: Env): pg.PoolConfig["ssl"] {
  const mode = env["CIXTECH_DB_SSL"]?.trim().toLowerCase();
  if (mode === "disable") return false;
  if (mode === "no-verify") return { rejectUnauthorized: false };
  if (mode === "require") return { rejectUnauthorized: true };
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {}
  return LOCAL_HOSTS.has(host) ? false : { rejectUnauthorized: true };
}
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
  describe: string;
  close(): Promise<void>;
}

const PLACEHOLDER_MARKERS = ["ep-REPLACE", "ep-xxx", ":PASSWORD@", "://OWNER:", "user:pass@"];
export function assertNotPlaceholder(variable: string, url: string): void {
  if (PLACEHOLDER_MARKERS.some((m) => url.includes(m))) {
    throw new DatabasePlaceholderUrlError(variable, redactDatabaseUrl(url));
  }
}
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
    ...(opts.schema ? { options: `-c search_path=${opts.schema}` } : {}),
  });
  pool.on("error", (err) => console.error("[db] idle client error", err.message));
  return {
    sql: pgClient(pool),
    describe: redactDatabaseUrl(url),
    close: () => pool.end(),
  };
}
export function openDatabase(env: Env, opts: OpenDatabaseOptions = {}): Database {
  const urls = resolveDatabaseUrls(env);
  if (!urls) throw new DatabaseNotConfiguredError();
  const url = opts.direct ? urls.directUrl : urls.url;
  assertNotPlaceholder(opts.direct && urls.hasDirect ? "DIRECT_DATABASE_URL" : "DATABASE_URL", url);
  return openDatabaseUrl(url, env, opts);
}
