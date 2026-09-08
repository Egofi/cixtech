import { assertTenantTablesProtected, withTenant } from "@/api/rls.js";
import { applySchemas } from "@/api/sql.js";
import { freshDatabase } from "@test/support/index.js";
import { describe, expect, it } from "vitest";

describe("row-level security (§13)", () => {
  it("applySchemas leaves every tenant-scoped table with an RLS policy (boot check passes)", async () => {
    const sql = (await freshDatabase()).sql;
    await applySchemas(sql); // runs assertTenantTablesProtected internally — throws if any table is unprotected
    await expect(assertTenantTablesProtected(sql)).resolves.toBeUndefined();
  });

  it("FAILS the boot check when a tenant-scoped table has no policy", async () => {
    const sql = (await freshDatabase()).sql;
    await applySchemas(sql);
    // Introduce a new tenant-scoped table with NO policy — exactly what §13 forbids.
    await sql.exec("CREATE TABLE rogue_ledger (id text PRIMARY KEY, tenant_id text NOT NULL);");
    await expect(assertTenantTablesProtected(sql)).rejects.toThrow(/rogue_ledger/);
  });

  it("enables RLS and installs an isolation policy on every tenant-scoped table", async () => {
    const sql = (await freshDatabase()).sql;
    await applySchemas(sql);
    for (const table of [
      "account",
      "api_key",
      "pool_address",
      "payout_allowlist",
      "payout_intent",
    ]) {
      const enabled = await sql.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
        `SELECT c.relrowsecurity, c.relforcerowsecurity
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE c.relname = $1 AND n.nspname = current_schema()`,
        [table],
      );
      expect(enabled.rows[0]?.relrowsecurity, `RLS enabled on ${table}`).toBe(true);
      // FORCE is what makes the policy apply to the owning role too — without it
      // the whole layer is inert on managed Postgres (ADR 0013).
      expect(enabled.rows[0]?.relforcerowsecurity, `RLS forced on ${table}`).toBe(true);
      const policies = await sql.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM pg_policies WHERE tablename = $1 AND schemaname = current_schema()",
        [table],
      );
      expect(Number(policies.rows[0]?.count), `policy on ${table}`).toBeGreaterThan(0);
    }
  });

  it("withTenant runs a tenant-scoped unit of work by binding the isolation GUC", async () => {
    const sql = (await freshDatabase()).sql;
    await applySchemas(sql);
    const seen = await withTenant(sql, "t1", (tx) =>
      tx.query<{ v: string | null }>("SELECT current_setting('cixtech.tenant', true) AS v"),
    );
    expect(seen.rows[0]?.v).toBe("t1");
  });
});
