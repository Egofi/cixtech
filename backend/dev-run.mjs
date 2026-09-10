import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { bundleFile } from "./bundle.mjs";

const here = import.meta.dirname;

const ENTRIES = {
  api: "src/api/server.ts",
  worker: "src/worker/main.ts",
  migrate: "src/api/migrate.ts",
};

function stripInlineComment(raw) {
  const v = raw.trim();
  if (v.startsWith('"') || v.startsWith("'")) {
    const quote = v[0];
    const end = v.indexOf(quote, 1);
    return end === -1 ? v.slice(1) : v.slice(1, end);
  }
  return v.replace(/\s+#.*$/, "").trim();
}

function parseEnvFile(file) {
  const out = [];
  for (const raw of readFileSync(file, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.replace(/^export\s+/, "").match(/^([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (m) out.push([m[1], stripInlineComment(m[2])]);
  }
  return out;
}

function loadEnv() {
  const files = [
    resolve(here, process.env["CIXTECH_ENV_FILE"] ?? ".env.dev"),
    resolve(here, ".env"),
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
    loaded.push(`${file.replace(`${here}/`, "")} (${applied})`);
  }
  if (loaded.length > 0) console.log(`[env] loaded ${loaded.join(", ")}`);
}

const which = process.argv[2] ?? "api";
const entry = ENTRIES[which];
if (!entry) {
  console.error(`Unknown entry "${which}". Expected one of: ${Object.keys(ENTRIES).join(", ")}`);
  process.exit(1);
}

loadEnv();
const out = await bundleFile(resolve(here, entry), resolve(here, `.dev-${which}.mjs`));
await import(pathToFileURL(out).href);
