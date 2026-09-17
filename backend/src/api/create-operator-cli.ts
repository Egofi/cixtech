/**
 * Create a person who can sign in: an operator for the admin plane, or a tenant
 * user for `/v1` (ADR 0018).
 *
 *   node dist/create-operator.mjs --email you@example.com --role owner
 *
 * This exists as its own bundled entry so it can run **inside the api container**,
 * where DATABASE_URL already points at Postgres over the compose network. The
 * host script `pnpm create-operator` does the same thing but needs Postgres
 * published, which the proxied topology deliberately does not do -- and the first
 * operator has to be creatable without loosening that.
 *
 * A separate file from `create-operator.ts` rather than a self-invoking guard
 * inside it: that module is also imported by the host script, and a guard
 * matching "create-operator" in argv[1] would fire there too and create the
 * account twice. The same shape of bug as the one that made `pnpm db:migrate` a
 * silent no-op.
 */
import { createOperator } from "./create-operator.js";

const args = process.argv.slice(2);
const arg = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : undefined;
};

async function main(): Promise<number> {
  const email = arg("email");
  if (!email) {
    console.error(
      [
        "Usage: node dist/create-operator.mjs --email you@example.com [--role owner|operator|viewer]",
        "       node dist/create-operator.mjs --kind tenant_user --tenant <id> --email a@b.com --role admin",
        "",
        "Roles: owner (everything, incl. staff and the fee sweep), operator (kill",
        "switch, tenants, keys), viewer (read). owner and operator require TOTP.",
      ].join("\n"),
    );
    return 1;
  }

  const role = arg("role") ?? "owner";
  const kind = arg("kind") ?? "operator";
  const tenantId = arg("tenant");
  // Generated rather than taken on the command line, so it never reaches shell
  // history. It must be changed on first sign-in regardless.
  const password =
    arg("password") ?? (await import("node:crypto")).randomBytes(18).toString("base64url");

  const result = await createOperator({
    kind,
    email,
    role,
    ...(tenantId ? { tenantId } : {}),
    password,
  });

  if (!result.ok) {
    console.error(`\n  ${result.error}\n`);
    return 1;
  }

  console.log(
    [
      "",
      "  Account created.",
      "",
      `    email     ${email}`,
      `    role      ${role}`,
      `    kind      ${kind}`,
      ...(tenantId ? [`    tenant    ${tenantId}`] : []),
      `    password  ${password}`,
      "",
      "  Shown once. It must be changed on first sign-in.",
      ...(result.totpRequired
        ? ["  This role requires a second factor; enrolment happens during that sign-in.", ""]
        : [""]),
    ].join("\n"),
  );
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error(`\n  failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
