import { AsyncLocalStorage } from "node:async_hooks";
import type { SqlClient } from "@cixtech/ledger";

/**
 * Bind row-level security to the request that is actually running (build spec §13).
 *
 * `rls.ts` installs and FORCEs a policy on every tenant-scoped table, and the
 * policy keys on the `cixtech.tenant` GUC. But the GUC is transaction-local, and
 * nothing in the request path was ever setting it — so `current_setting(...)` was
 * always NULL, the policy's first clause matched every row, and RLS filtered
 * precisely nothing at runtime. Isolation rested entirely on remembering to write
 * `WHERE tenant = $1` in every query, which is the assumption RLS exists to stop
 * depending on.
 *
 * Threading a per-request client through the engine would mean rebuilding every
 * store per request. Instead the tenant travels in an `AsyncLocalStorage` for the
 * duration of the request, and the shared `SqlClient` is wrapped so each statement
 * issued inside that context binds the GUC first.
 *
 * What is deliberately NOT scoped: the admin plane, the detection loop, the
 * webhook dispatcher and the pool sweeper all run with no tenant in context, so
 * `currentTenantId()` is undefined, no GUC is set, and they keep their
 * cross-tenant reads. That is the same "unset GUC means unrestricted" contract
 * `rls.ts` already documents — it is now a deliberate exemption rather than the
 * only behaviour the system had.
 */
const store = new AsyncLocalStorage<{ tenantId: string }>();

/** The tenant whose request is currently executing, if any. */
export const currentTenantId = (): string | undefined => store.getStore()?.tenantId;

/**
 * Run `fn` — and everything it awaits — as the given tenant.
 *
 * The callback form matters for Fastify: calling `done()` from inside
 * `AsyncLocalStorage.run` is what carries the context into the remaining hooks and
 * the route handler, because Fastify continues the chain synchronously from that
 * call. Wrapping only the hook itself would lose the context before the handler
 * ever ran.
 */
export function runAsTenant<T>(tenantId: string, fn: () => T): T {
  return store.run({ tenantId }, fn);
}

const BIND = "SELECT set_config('cixtech.tenant', $1, true)";

/**
 * Wrap a `SqlClient` so every statement issued inside a tenant scope runs with the
 * RLS GUC bound, and every statement outside one behaves exactly as before.
 *
 * `set_config(..., true)` is transaction-LOCAL, which is the only safe choice on a
 * pooled connection: a session-local setting would outlive the request and leak
 * onto whatever borrowed the connection next. So a bare `query` inside a scope is
 * promoted to a single-statement transaction that binds the GUC first. That costs
 * a round trip per read; tenant isolation on a custody ledger is worth a round
 * trip, and the alternative — a GUC that survives the request — is a cross-tenant
 * data leak waiting for the right pool reuse.
 */
export function tenantScopedSql<T extends SqlClient>(sql: T): T {
  // `exec` (multi-statement DDL, on MigratableSqlClient) passes straight through:
  // schema work runs at boot with no tenant in context, and wrapping it would both
  // break the type and try to open a transaction around DDL.
  const withExec = sql as T & { exec?: (s: string) => Promise<void> };
  const passthrough = withExec.exec ? { exec: (s: string) => withExec.exec?.(s) } : {};
  return {
    ...passthrough,
    async query<R>(text: string, params?: readonly unknown[]) {
      const tenantId = currentTenantId();
      if (tenantId === undefined) return sql.query<R>(text, params);
      return sql.transaction(async (tx) => {
        await tx.query(BIND, [tenantId]);
        return tx.query<R>(text, params);
      });
    },
    async transaction<T>(fn: (tx: SqlClient) => Promise<T>) {
      const tenantId = currentTenantId();
      if (tenantId === undefined) return sql.transaction(fn);
      return sql.transaction(async (tx) => {
        // Bound once for the whole unit of work; `fn` receives `tx` directly, so
        // every statement it issues is already inside this bound transaction.
        await tx.query(BIND, [tenantId]);
        return fn(tx);
      });
    },
  } as unknown as T;
}
