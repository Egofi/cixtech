import { applySchemas } from "@/api/sql.js";
import { runAsTenant, tenantScopedSql } from "@/api/tenant-scope.js";
import { kyselyFor } from "@/postgres";
import { ApprovalStore } from "@/stores";
import type { SqlClient } from "@/types";
import { freshDatabase } from "@test/support/index.js";
import { describe, expect, it } from "vitest";

function recorder() {
  const bound: string[] = [];
  const statements: string[] = [];
  const wrap = (inner: SqlClient): SqlClient => ({
    async query<R>(text: string, params?: readonly unknown[]) {
      statements.push(text);
      if (text.includes("set_config") && text.includes("cixtech.tenant")) {
        bound.push(String(params?.[0] ?? ""));
      }
      return inner.query<R>(text, params);
    },
    transaction: (fn) => inner.transaction((tx) => fn(wrap(tx))),
  });
  return { bound, statements, wrap };
}

describe("Kysely runs through SqlClient, so tenant scoping still applies", () => {
  it("compiles to parameterised SQL and issues it on the injected client", async () => {
    const db = await freshDatabase();
    await applySchemas(db.sql);
    const rec = recorder();

    const rows = await kyselyFor(rec.wrap(db.sql))
      .selectFrom("payout_approval")
      .select("approver")
      .where("intent_key", "=", "intent-1")
      .execute();

    expect(rows).toEqual([]);
    const issued = rec.statements.find((s) => s.includes("payout_approval"));
    expect(issued).toContain('"intent_key" = $1');
    expect(issued).not.toContain("intent-1");
  });

  it("binds cixtech.tenant for a Kysely query inside a tenant scope", async () => {
    const db = await freshDatabase();
    await applySchemas(db.sql);
    const rec = recorder();
    const scoped = tenantScopedSql(rec.wrap(db.sql));

    await runAsTenant("tenant-a", async () => {
      await kyselyFor(scoped).selectFrom("payout_approval").select("approver").execute();
    });

    expect(rec.bound).toEqual(["tenant-a"]);
  });

  it("binds nothing outside a tenant scope, so the admin plane still reads across tenants", async () => {
    const db = await freshDatabase();
    await applySchemas(db.sql);
    const rec = recorder();

    await kyselyFor(tenantScopedSql(rec.wrap(db.sql)))
      .selectFrom("payout_approval")
      .select("approver")
      .execute();

    expect(rec.bound).toEqual([]);
  });

  it("refuses a Kysely-level transaction, naming the pattern that keeps the GUC bound", async () => {
    const db = await freshDatabase();
    await applySchemas(db.sql);

    await expect(
      kyselyFor(db.sql)
        .transaction()
        .execute(async (tx) => tx.selectFrom("payout_approval").select("approver").execute()),
    ).rejects.toThrow(/SqlClient|cixtech\.tenant/i);
  });

  it("keeps a converted store's behaviour identical through the query builder", async () => {
    const db = await freshDatabase();
    await applySchemas(db.sql);
    const store = new ApprovalStore(db.sql);

    const first = await store.approve({
      tenant: "t1",
      intentKey: "i1",
      approver: "alice",
      requestedBy: "bob",
    });
    const repeat = await store.approve({
      tenant: "t1",
      intentKey: "i1",
      approver: "alice",
      requestedBy: "bob",
    });

    expect(first.recorded).toBe(true);
    expect(repeat.recorded).toBe(false);
    expect(await store.approversFor("i1")).toEqual(["alice"]);

    const listed = await store.listFor("i1");
    expect(listed).toHaveLength(1);
    expect(listed[0]?.at).toBeInstanceOf(Date);

    await expect(
      store.approve({ tenant: "t1", intentKey: "i1", approver: "bob", requestedBy: "bob" }),
    ).rejects.toThrow(/never approve/i);
  });
});
