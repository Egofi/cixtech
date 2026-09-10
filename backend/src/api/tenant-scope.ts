import { AsyncLocalStorage } from "node:async_hooks";
import type { SqlClient } from "@/types";

const store = new AsyncLocalStorage<{ tenantId: string }>();

export const currentTenantId = (): string | undefined => store.getStore()?.tenantId;

export function runAsTenant<T>(tenantId: string, fn: () => T): T {
  return store.run({ tenantId }, fn);
}

const BIND = "SELECT set_config('cixtech.tenant', $1, true)";

export function tenantScopedSql<T extends SqlClient>(sql: T): T {
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
        await tx.query(BIND, [tenantId]);
        return fn(tx);
      });
    },
  } as unknown as T;
}
