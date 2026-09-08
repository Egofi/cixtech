/**
 * Create the first operator account.
 *
 *   pnpm create-operator --email you@example.com --role owner
 *
 * This is the bootstrap path, and it exists so the shared admin token never has
 * to be a permanent way in. It talks to the database directly, so it also works
 * when nobody can sign in at all — a lost password, a lost authenticator, an
 * account disabled by mistake.
 *
 * The password is generated unless one is supplied, printed once, and flagged
 * must-change so it cannot outlive the handover.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function stripInlineComment(raw) {
  const v = raw.trim();
  if (v.startsWith('"') || v.startsWith("'")) {
    const q = v[0];
    const end = v.indexOf(q, 1);
    return end === -1 ? v.slice(1) : v.slice(1, end);
  }
  return v.replace(/\s+#.*$/, "").trim();
}

for (const file of [resolve(root, ".env.dev"), resolve(root, ".env")]) {
  if (!existsSync(file)) continue;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 1) continue;
    const key = t.slice(0, eq).trim();
    if (process.env[key] === undefined) process.env[key] = stripInlineComment(t.slice(eq + 1));
  }
}

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
};

const email = arg("email");
const role = arg("role", "owner");
const kind = arg("kind", "operator");
const tenantId = arg("tenant");
const password = arg("password", randomBytes(18).toString("base64url"));

if (!email) {
  console.error(
    "Usage: pnpm create-operator --email you@example.com [--role owner|operator|viewer]\n" +
      "       pnpm create-operator --kind tenant_user --tenant <id> --email a@b.com --role admin",
  );
  process.exit(1);
}

// Bundle the auth module the same way the server is built, so this runs against
// exactly the code the engine runs — not a re-implementation that can drift.
const { bundleFile } = await import(pathToFileURL(resolve(root, "bundle.mjs")).href);
const entry = resolve(root, ".create-operator.mjs");
await bundleFile(resolve(root, "scripts/create-operator-entry.ts"), entry);
const mod = await import(pathToFileURL(entry).href);

const result = await mod.createOperator({ kind, email, role, tenantId, password });
if (!result.ok) {
  console.error(`\n  ${result.error}\n`);
  process.exit(1);
}

console.log(`
  Account created.

    email     ${email}
    role      ${role}
    kind      ${kind}${tenantId ? `\n    tenant    ${tenantId}` : ""}
    password  ${password}

  This password is shown once and must be changed on first sign-in.
${result.totpRequired ? "  This role requires a second factor; enrolment happens during that sign-in.\n" : ""}`);

void spawnSync;
