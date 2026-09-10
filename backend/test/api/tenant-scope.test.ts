import { applySchemas } from "@/api/sql.js";
import { currentTenantId, runAsTenant, tenantScopedSql } from "@/api/tenant-scope.js";
import type { SqlClient } from "@/types";

import { freshDatabase } from "@test/support/index.js";
import { beforeEach, describe, expect, it } from "vitest";
import { adminAuth, auth, makeApi } from "./harness.js";

function recorder() {
  const bound: string[] = [];
  const wrap = (inner: SqlClient): SqlClient => ({
    async query<R>(text: string, params?: readonly unknown[]) {
      if (text.includes("cixtech.tenant") && text.includes("set_config")) {
        bound.push(String(params?.[0] ?? ""));
      }
      return inner.query<R>(text, params);
    },
    transaction: (fn) => inner.transaction((tx) => fn(wrap(tx))),
  });
  return { bound, wrap };
}

describe("row-level security is actually engaged on a request (§13)", () => {
  it("binds cixtech.tenant on the statements an authenticated request issues", async () => {
    const rec = recorder();
    const { app, apiKey, tenant } = await makeApi({ wrapSql: rec.wrap });

    const res = await app.inject({ method: "GET", url: "/v1/balances", headers: auth(apiKey) });
    expect(res.statusCode).toBe(200);

    expect(rec.bound.length).toBeGreaterThan(0);
    expect(new Set(rec.bound)).toEqual(new Set([tenant.id]));
  });

  it("does not bind it for the admin plane, which must read across tenants", async () => {
    const rec = recorder();
    const { app } = await makeApi({ wrapSql: rec.wrap });

    const res = await app.inject({
      method: "GET",
      url: "/admin/api/overview",
      headers: adminAuth(),
    });
    expect(res.statusCode).toBe(200);
    expect(rec.bound).toEqual([]);
  });

  it("gives each request its own tenant, and leaves no scope behind", async () => {
    const rec = recorder();
    const { app, engine, apiKey, tenant } = await makeApi({ wrapSql: rec.wrap });
    const other = await engine.tenants.createTenant("second");

    await app.inject({ method: "GET", url: "/v1/balances", headers: auth(apiKey) });
    const first = [...new Set(rec.bound)];
    rec.bound.length = 0;
    await app.inject({ method: "GET", url: "/v1/balances", headers: auth(other.apiKey) });
    const second = [...new Set(rec.bound)];

    expect(first).toEqual([tenant.id]);
    expect(second).toEqual([other.tenant.id]);
    expect(currentTenantId()).toBeUndefined();
  });

  it("keeps concurrent requests in their own scopes", async () => {
    const seen: Record<string, string[]> = {};
    const { app, engine, apiKey, tenant } = await makeApi({
      wrapSql: (inner) => {
        const wrap = (i: SqlClient): SqlClient => ({
          async query<R>(text: string, params?: readonly unknown[]) {
            if (text.includes("set_config") && text.includes("cixtech.tenant")) {
              const id = String(params?.[0] ?? "");
              const list = seen[id] ?? [];
              list.push(id);
              seen[id] = list;
            }
            return i.query<R>(text, params);
          },
          transaction: (fn) => i.transaction((tx) => fn(wrap(tx))),
        });
        return wrap(inner);
      },
    });
    const other = await engine.tenants.createTenant("concurrent");

    await Promise.all([
      app.inject({ method: "GET", url: "/v1/deposits", headers: auth(apiKey) }),
      app.inject({ method: "GET", url: "/v1/deposits", headers: auth(other.apiKey) }),
    ]);

    expect(Object.keys(seen).sort()).toEqual([tenant.id, other.tenant.id].sort());
  });
});

describe("with a role that RLS actually constrains", () => {
  let db: Awaited<ReturnType<typeof freshDatabase>>;
  let scoped: ReturnType<typeof tenantScopedSql>;

  beforeEach(async () => {
    db = await freshDatabase();
    await applySchemas(db.sql);
    scoped = tenantScopedSql((await db.asAppRole()).sql);
    for (const t of ["tenant-a", "tenant-b"]) {
      await db.sql.query("INSERT INTO tenant (id, name) VALUES ($1, $1)", [t]);
      await db.sql.query("INSERT INTO account (id, tenant_id) VALUES ($1, $2)", [`${t}-acct`, t]);
    }
  });

  it("hides another tenant's rows from a scoped read, and shows them to an unscoped one", async () => {
    const asA = await runAsTenant("tenant-a", () =>
      scoped.query<{ tenant_id: string }>("SELECT tenant_id FROM account"),
    );
    expect(asA.rows.map((r) => r.tenant_id)).toEqual(["tenant-a"]);

    const asB = await runAsTenant("tenant-b", () =>
      scoped.query<{ tenant_id: string }>("SELECT tenant_id FROM account"),
    );
    expect(asB.rows.map((r) => r.tenant_id)).toEqual(["tenant-b"]);

    const all = await scoped.query<{ tenant_id: string }>("SELECT tenant_id FROM account");
    expect(all.rows.map((r) => r.tenant_id).sort()).toEqual(["tenant-a", "tenant-b"]);
  });

  it("binds the GUC across a whole transaction, not just its first statement", async () => {
    const seen = await runAsTenant("tenant-a", () =>
      scoped.transaction(async (tx) => {
        await tx.query("SELECT 1");
        return tx.query<{ tenant_id: string }>("SELECT tenant_id FROM account");
      }),
    );
    expect(seen.rows.map((r) => r.tenant_id)).toEqual(["tenant-a"]);
  });
});
