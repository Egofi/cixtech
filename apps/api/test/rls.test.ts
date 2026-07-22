import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { assertTenantTablesProtected, withTenant } from "../src/rls.js";
import { applySchemas, pgliteClient } from "../src/sql.js";

describe("row-level security (§13)", () => {
  it("applySchemas leaves every tenant-scoped table with an RLS policy (boot check passes)", async () => {
    const db = new PGlite();
    await applySchemas(db); // runs assertTenantTablesProtected internally — throws if any table is unprotected
    await expect(assertTenantTablesProtected(pgliteClient(db))).resolves.toBeUndefined();
  });

  it("FAILS the boot check when a tenant-scoped table has no policy", async () => {
    const db = new PGlite();
    await applySchemas(db);
    // Introduce a new tenant-scoped table with NO policy — exactly what §13 forbids.
    await db.exec("CREATE TABLE rogue_ledger (id text PRIMARY KEY, tenant_id text NOT NULL);");
    await expect(assertTenantTablesProtected(pgliteClient(db))).rejects.toThrow(/rogue_ledger/);
  });

  it("enables RLS and installs an isolation policy on every tenant-scoped table", async () => {
    const db = new PGlite();
    await applySchemas(db);
    const sql = pgliteClient(db);
    for (const table of [
      "account",
      "api_key",
      "pool_address",
      "payout_allowlist",
      "payout_intent",
    ]) {
      const enabled = await sql.query<{ relrowsecurity: boolean }>(
        "SELECT relrowsecurity FROM pg_class WHERE relname = $1",
        [table],
      );
      expect(enabled.rows[0]?.relrowsecurity, `RLS enabled on ${table}`).toBe(true);
      const policies = await sql.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM pg_policies WHERE tablename = $1",
        [table],
      );
      expect(Number(policies.rows[0]?.count), `policy on ${table}`).toBeGreaterThan(0);
    }
  });

  it("withTenant runs a tenant-scoped unit of work by binding the isolation GUC", async () => {
    const db = new PGlite();
    await applySchemas(db);
    const sql = pgliteClient(db);
    const seen = await withTenant(sql, "t1", (tx) =>
      tx.query<{ v: string | null }>("SELECT current_setting('cixtech.tenant', true) AS v"),
    );
    expect(seen.rows[0]?.v).toBe("t1");
  });
});
