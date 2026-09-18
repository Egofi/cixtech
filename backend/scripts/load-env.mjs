import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const BACKEND_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Trailing `# comment` is stripped, but only when it is not inside quotes --
 * a `#` can legitimately appear in a password or a connection string.
 */
function stripInlineComment(value) {
  const v = value.trim();
  if (v.startsWith('"') || v.startsWith("'")) {
    const quote = v[0];
    const end = v.indexOf(quote, 1);
    return end === -1 ? v.slice(1) : v.slice(1, end);
  }
  return v.replace(/\s+#.*$/, "").trim();
}

export function parseEnvFile(file) {
  const out = [];
  for (const raw of readFileSync(file, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.replace(/^export\s+/, "").match(/^([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (m) out.push([m[1], stripInlineComment(m[2])]);
  }
  return out;
}

/**
 * Load `.env.dev` then `.env` from the backend root into `process.env`.
 *
 * A real environment variable always wins, so an operator can override one value
 * for a single command without editing the file. Missing files are not an error;
 * every consumer reports its own missing variables with better context than a
 * loader could.
 *
 * Shared because it was previously defined three times: once in `dev-run.mjs`,
 * once copied into `verify-chain-config.mjs`, and once *imported by
 * `generate-test-key.mjs` from `apps/api/bundle.mjs`* -- a path left over from the
 * monorepo split that has not existed since, so that script crashed on startup.
 */
export function loadEnv({ quiet = false } = {}) {
  const files = [
    resolve(BACKEND_ROOT, process.env["CIXTECH_ENV_FILE"] ?? ".env.dev"),
    resolve(BACKEND_ROOT, ".env"),
  ];
  const loaded = [];
  for (const file of files) {
    if (!existsSync(file)) continue;
    let applied = 0;
    for (const [k, v] of parseEnvFile(file)) {
      if (process.env[k] === undefined) {
        process.env[k] = v;
        applied++;
      }
    }
    loaded.push(
      `${file.replace(`${BACKEND_ROOT}\\`, "").replace(`${BACKEND_ROOT}/`, "")} (${applied})`,
    );
  }
  if (!quiet && loaded.length > 0) console.log(`[env] loaded ${loaded.join(", ")}`);
  return loaded;
}
