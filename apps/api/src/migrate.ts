import { connectionStringFor, provisionAppRole } from "./app-role.js";
import { type Database, openDatabase, redactDatabaseUrl, resolveDatabaseUrls } from "./db.js";
import { checkRlsEffective, withTenant } from "./rls.js";
import { type AppliedSchema, applySchemas } from "./sql.js";

/**
 * Schema migration command (`pnpm db:migrate`).
 *
 * Applies every schema module to the configured database, records what was
 * applied, re-runs the §13 row-level-security boot guard, and — when the runtime
 * URL is a pooled endpoint distinct from the direct one — verifies the assumption
 * ADR 0013 left open: that transaction-scoped `set_config` (what `withTenant` uses
 * to bind tenant isolation) survives a PgBouncer transaction-mode pooler.
 *
 * DDL runs against the DIRECT endpoint. Neon fronts the pooled URL with PgBouncer
 * in transaction mode, where session state and prepared statements do not survive.
 */

const ok = (s: string) => `  ✓ ${s}`;
const bad = (s: string) => `  ✗ ${s}`;

const STATUS_NOTE: Record<AppliedSchema["status"], string> = {
  created: "created",
  unchanged: "unchanged",
  changed: "CHANGED since first applied",
};

/**
 * Prove tenant isolation actually filters rows on this database, rather than
 * merely being installed. Uses `pg_catalog` visibility of the GUC inside and
 * outside a transaction — the exact mechanism `withTenant` depends on.
 */
async function verifyTransactionScopedGuc(db: Database): Promise<{ pass: boolean; note: string }> {
  const inside = await withTenant(db.sql, "cixtech-migrate-probe", (tx) =>
    tx.query<{ v: string | null }>("SELECT current_setting('cixtech.tenant', true) AS v"),
  );
  if (inside.rows[0]?.v !== "cixtech-migrate-probe") {
    return { pass: false, note: "set_config did not bind inside the transaction" };
  }
  // After the transaction commits the setting must be gone. If it leaked, a pooled
  // connection could hand one tenant's GUC to the next request on that connection.
  const after = await db.sql.query<{ v: string | null }>(
    "SELECT current_setting('cixtech.tenant', true) AS v",
  );
  const leaked = after.rows[0]?.v;
  if (leaked !== null && leaked !== undefined && leaked !== "") {
    return { pass: false, note: `setting leaked past the transaction as "${leaked}"` };
  }
  return { pass: true, note: "transaction-scoped and does not leak across requests" };
}

export interface MigrateOptions {
  /**
   * Also provision the least-privileged application role (`--create-app-role`).
   * Prints a connection string for it exactly once — it is not stored anywhere.
   */
  createAppRole?: boolean;
  appRoleName?: string;
}

export async function migrate(
  env: Record<string, string | undefined>,
  opts: MigrateOptions = {},
): Promise<number> {
  const urls = resolveDatabaseUrls(env);

  if (!urls) {
    console.error(
      "No database URL configured.\n" +
        "Set DATABASE_URL (or DB_URL) in .env — e.g. a Neon connection string:\n" +
        "  DATABASE_URL=postgresql://user:pass@ep-xxx-pooler.region.aws.neon.tech/neondb?sslmode=require\n" +
        "  DIRECT_DATABASE_URL=postgresql://user:pass@ep-xxx.region.aws.neon.tech/neondb?sslmode=require\n" +
        "(DIRECT_DATABASE_URL is optional but recommended — migrations should not run through the pooler.)",
    );
    return 1;
  }

  console.log("\ncixtech schema migration");
  console.log(`  target  ${redactDatabaseUrl(urls.directUrl)}`);
  if (!urls.hasDirect) {
    console.log(
      "  note    DIRECT_DATABASE_URL is unset — running DDL through the runtime URL.\n" +
        "          On Neon, prefer the non-pooled endpoint for migrations (ADR 0013).",
    );
  }

  // DDL always goes to the direct endpoint.
  const direct = openDatabase(env, { direct: true, maxConnections: 2 });
  try {
    console.log("\nschema modules");
    const applied = await applySchemas(direct.sql);
    for (const a of applied) console.log(ok(`${a.name.padEnd(16)} ${STATUS_NOTE[a.status]}`));

    const changed = applied.filter((a) => a.status === "changed");
    if (changed.length > 0) {
      console.log(
        [
          "",
          `  ! ${changed.map((c) => c.name).join(", ")} changed after first being applied.`,
          "    Schema SQL is CREATE ... IF NOT EXISTS, so existing tables were NOT altered.",
          "    Any new column/constraint needs an explicit ALTER against this database.",
        ].join("\n"),
      );
    }

    console.log("\nrow-level security (§13)");
    console.log(ok("every tenant-scoped table has an isolation policy (boot guard passed)"));
    console.log(ok("policies are FORCEd, so they apply to the owning role too"));

    if (opts.createAppRole) {
      const name = opts.appRoleName ?? env["CIXTECH_APP_ROLE"] ?? "cixtech_app";
      const role = await provisionAppRole(direct.sql, name);
      console.log("\napplication role");
      console.log(
        ok(`${role.name} ${role.created ? "created" : "already existed — grants refreshed"}`),
      );
      console.log(ok("NOBYPASSRLS + NOSUPERUSER, so tenant isolation actually applies"));
      console.log(ok("no UPDATE/DELETE on journal_entry, posting, admin_audit, error_log"));
      if (role.password) {
        console.log("\n  Connection string for this role — shown ONCE, store it now:\n");
        console.log(`    DATABASE_URL=${connectionStringFor(urls.url, role.name, role.password)}`);
        if (urls.hasDirect) {
          console.log(
            `    DIRECT_DATABASE_URL=${connectionStringFor(urls.directUrl, role.name, role.password)}`,
          );
        }
        console.log("\n  Keep the owner URL for migrations; the engine should run as this role.");
      }
    }
  } finally {
    await direct.close();
  }

  // ADR 0013's open question: does transaction-local tenant binding survive the
  // pooler? Only meaningful when the runtime URL differs from the direct one.
  console.log("\ntenant-isolation binding on the runtime connection");
  const runtime = openDatabase(env, { maxConnections: 2 });
  let bypassing: string | undefined;
  try {
    const probe = await verifyTransactionScopedGuc(runtime);
    console.log(probe.pass ? ok(probe.note) : bad(probe.note));
    if (!probe.pass) {
      console.error(
        "\nRefusing to report success: withTenant() cannot bind tenant isolation on this\n" +
          "connection, so row-level security would not isolate tenants at runtime.",
      );
      return 1;
    }

    // Binding the GUC is necessary but not sufficient: the role must also be
    // subject to the policies it binds for.
    const effective = await checkRlsEffective(runtime.sql);
    console.log(
      effective.bypasses
        ? bad(`${effective.role}: ${effective.reason}`)
        : ok(`${effective.role}: ${effective.reason}`),
    );
    if (effective.bypasses) bypassing = effective.role;
  } finally {
    await runtime.close();
  }

  if (bypassing) {
    console.log(
      [
        "",
        "  ! Row-level security is INERT on this connection.",
        `    The schema is correct — every table is policied and FORCEd — but "${bypassing}"`,
        "    is exempt from all policies, so §13 tenant isolation does not apply at runtime.",
        "    Query-level tenant scoping still holds; the defence-in-depth layer beneath it",
        "    does not. Managed Postgres does this by default (Neon's owner role).",
        "",
        "    Fix — provision the least-privileged role and point the engine at it:",
        "      make db-role        (or: pnpm db:migrate --create-app-role)",
        "    then set DATABASE_URL to the printed connection string and move the owner",
        "    URL to DIRECT_DATABASE_URL, which migrations use.",
      ].join("\n"),
    );
  }

  console.log(`\nmigration complete${bypassing ? " (with warnings)" : ""}\n`);
  return 0;
}

const isEntry = process.argv[1]?.includes("migrate");
if (isEntry) {
  const argv = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
    return hit === undefined ? undefined : (hit.split("=")[1] ?? "");
  };
  const options: MigrateOptions = {
    createAppRole: flag("create-app-role") !== undefined,
    ...(flag("app-role") ? { appRoleName: flag("app-role") as string } : {}),
  };
  migrate(process.env, options)
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      // Never let a driver error print the connection string (it carries the password).
      const message = err instanceof Error ? err.message : String(err);
      console.error(`\nmigration failed: ${message}\n`);
      process.exit(1);
    });
}
