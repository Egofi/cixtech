import { redactDatabaseUrl, resolveDatabaseUrls } from "@/api/db.js";
import { SCHEMA_MODULES, applySchemas, assertSchemaReady } from "@/api/sql.js";
import { freshDatabase } from "@test/support/index.js";
import { describe, expect, it } from "vitest";

const NEON = "postgresql://user:s3cr3t@ep-x-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require";
const NEON_DIRECT = "postgresql://user:s3cr3t@ep-x.us-east-2.aws.neon.tech/neondb?sslmode=require";

describe("database URL resolution (ADR 0013)", () => {
  it("returns undefined when nothing is configured, so the caller can fall back", () => {
    expect(resolveDatabaseUrls({})).toBeUndefined();
    expect(resolveDatabaseUrls({ DATABASE_URL: "   " })).toBeUndefined();
  });

  it("accepts DB_URL as an alias but prefers DATABASE_URL", () => {
    expect(resolveDatabaseUrls({ DB_URL: NEON })?.url).toBe(NEON);
    expect(resolveDatabaseUrls({ DB_URL: NEON_DIRECT, DATABASE_URL: NEON })?.url).toBe(NEON);
  });

  it("falls back to the pooled URL for DDL, and flags that it did", () => {
    const fallback = resolveDatabaseUrls({ DATABASE_URL: NEON });
    expect(fallback?.directUrl).toBe(NEON);
    expect(fallback?.hasDirect).toBe(false);

    const split = resolveDatabaseUrls({ DATABASE_URL: NEON, DIRECT_DATABASE_URL: NEON_DIRECT });
    expect(split?.directUrl).toBe(NEON_DIRECT);
    expect(split?.hasDirect).toBe(true);
  });

  it("never lets the password reach a log line", () => {
    const shown = redactDatabaseUrl(NEON);
    expect(shown).not.toContain("s3cr3t");
    expect(shown).toBe("postgresql://user@ep-x-pooler.us-east-2.aws.neon.tech/neondb");
    // A malformed string must not fall through to printing itself.
    expect(redactDatabaseUrl("not a url:s3cr3t")).not.toContain("s3cr3t");
  });
});

describe("schema migration bookkeeping", () => {
  it("records every module as created, then unchanged on a second run", async () => {
    const sql = (await freshDatabase()).sql;

    const first = await applySchemas(sql);
    expect(first.map((m) => m.name)).toEqual(SCHEMA_MODULES.map((m) => m.name));
    expect(first.every((m) => m.status === "created")).toBe(true);

    const second = await applySchemas(sql);
    expect(second.every((m) => m.status === "unchanged")).toBe(true);
  });

  it("reports a module whose SQL changed after it was applied, rather than calling it up to date", async () => {
    const sql = (await freshDatabase()).sql;
    await applySchemas(sql);
    // Simulate the code's SQL having moved on from what this database received.
    await sql.query("UPDATE schema_migration SET checksum = 'stale' WHERE name = 'ledger'");

    const applied = await applySchemas(sql);
    expect(applied.find((m) => m.name === "ledger")?.status).toBe("changed");
    // Everything else is untouched — drift is reported per module, not globally.
    expect(applied.filter((m) => m.status === "changed")).toHaveLength(1);
  });
});

describe("assertSchemaReady (the server's boot guard)", () => {
  it("refuses to boot against a database that was never migrated", async () => {
    const sql = (await freshDatabase()).sql;
    await expect(assertSchemaReady(sql)).rejects.toThrow(/run `pnpm db:migrate`/);
  });

  it("passes on a freshly migrated database", async () => {
    const sql = (await freshDatabase()).sql;
    await applySchemas(sql);
    await expect(assertSchemaReady(sql)).resolves.toBeUndefined();
  });

  it("refuses to boot when a module is missing", async () => {
    const sql = (await freshDatabase()).sql;
    await applySchemas(sql);
    await sql.query("DELETE FROM schema_migration WHERE name = 'pool'");
    await expect(assertSchemaReady(sql)).rejects.toThrow(/missing schema modules \[pool\]/);
  });

  it("refuses to boot when the recorded schema no longer matches the code", async () => {
    const sql = (await freshDatabase()).sql;
    await applySchemas(sql);
    await sql.query("UPDATE schema_migration SET checksum = 'stale' WHERE name = 'api'");
    await expect(assertSchemaReady(sql)).rejects.toThrow(/\[api\] changed since they were applied/);
  });
});
