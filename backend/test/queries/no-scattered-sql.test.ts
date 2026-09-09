import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Where a table query is allowed to be written. `src/queries` is the catalogue;
 * `src/schemas` is the DDL. Everything else asks the catalogue.
 */
const QUERY_HOMES = ["src/queries/", "src/schemas/"];

/**
 * Statements that are not table access and have nowhere better to live. Each is
 * named so that adding to this list is a decision someone has to argue for.
 */
const NOT_TABLE_ACCESS: ReadonlyArray<{ file: string; why: string }> = [
  { file: "src/api/tenant-scope.ts", why: "binds the cixtech.tenant GUC — the RLS control itself" },
  { file: "src/api/rls.ts", why: "reads pg_catalog to prove RLS is enabled, and binds the GUC" },
  { file: "src/api/app-role.ts", why: "reads pg_roles and current_schema()" },
  { file: "src/api/sql.ts", why: "the migration runner's own schema_migration bookkeeping" },
  { file: "src/api/migrate.ts", why: "verifies the GUC is transaction-scoped at migrate time" },
  { file: "src/api/app.ts", why: "SELECT 1 readiness probe" },
];

const SQL_LITERAL =
  /(`|")\s*(SELECT|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM)\b[\s\S]{0,400}?\1/gi;

function offenders(): Array<{ file: string; snippet: string }> {
  const files = execSync("find src -name '*.ts'").toString().trim().split("\n");
  const found: Array<{ file: string; snippet: string }> = [];
  for (const file of files) {
    if (QUERY_HOMES.some((home) => file.startsWith(home))) continue;
    if (NOT_TABLE_ACCESS.some((e) => e.file === file)) continue;
    const src = readFileSync(file, "utf8").replace(/\0/g, "");
    for (const m of src.matchAll(SQL_LITERAL)) {
      found.push({ file, snippet: m[0].replace(/\s+/g, " ").slice(0, 90) });
    }
  }
  return found;
}

describe("SQL lives in the query catalogue, not scattered through the code", () => {
  it("finds no table query written outside src/queries or src/schemas", () => {
    const scattered = offenders().map((o) => `${o.file}: ${o.snippet}`);

    expect(
      scattered,
      "Write the query in src/queries/<table>.queries.ts and call it from here.",
    ).toEqual([]);
  });

  it("keeps the exemption list honest — every entry still exists and still has SQL", () => {
    const stale: string[] = [];
    for (const entry of NOT_TABLE_ACCESS) {
      let src: string;
      try {
        src = readFileSync(entry.file, "utf8");
      } catch {
        stale.push(`${entry.file} no longer exists`);
        continue;
      }
      if (!SQL_LITERAL.test(src)) stale.push(`${entry.file} no longer contains SQL`);
      SQL_LITERAL.lastIndex = 0;
    }

    expect(stale, "an exemption that is no longer needed should be deleted").toEqual([]);
  });

  it("gives every query module a name that says which table it serves", () => {
    const modules = execSync("ls src/queries").toString().trim().split("\n");
    const bad = modules.filter((m) => m !== "index.ts" && !m.endsWith(".queries.ts"));

    expect(bad).toEqual([]);
    expect(modules.length).toBeGreaterThan(10);
  });
});
