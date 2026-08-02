// Shared dev tooling: load env files, then bundle a workspace TypeScript entry
// with esbuild so plain `node` can run it. Used by dev-run.mjs and migrate.mjs.
// No global installs — esbuild ships with the repo's test tooling.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
const require = createRequire(import.meta.url);

function parseEnvFile(file) {
  const found = [];
  for (const raw of readFileSync(file, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.replace(/^export\s+/, "").match(/^([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (!m) continue;
    found.push([m[1], m[2].replace(/^["']|["']$/g, "")]);
  }
  return found;
}

/**
 * Load env from, in order of precedence:
 *   1. the real process environment (always wins)
 *   2. apps/api/.env.dev  (or CIXTECH_ENV_FILE) — app-specific dev config
 *   3. <repo root>/.env                          — shared config, e.g. DATABASE_URL
 *
 * First value seen wins, so a more specific file overrides the shared one and a
 * real exported variable overrides both.
 */
export function loadEnv() {
  const files = [
    resolve(here, process.env["CIXTECH_ENV_FILE"] ?? ".env.dev"),
    resolve(repoRoot, ".env"),
  ];
  const loaded = [];
  for (const file of files) {
    if (!existsSync(file)) continue;
    let applied = 0;
    for (const [key, value] of parseEnvFile(file)) {
      if (process.env[key] === undefined) {
        process.env[key] = value;
        applied++;
      }
    }
    loaded.push(`${file.replace(`${repoRoot}/`, "")} (${applied})`);
  }
  if (loaded.length > 0) console.log(`[env] loaded ${loaded.join(", ")}`);
}

// esbuild is a transitive (pnpm) dep — resolve it from the store if not linked.
function loadEsbuild() {
  try {
    return require("esbuild");
  } catch {
    const store = resolve(repoRoot, "node_modules/.pnpm");
    const dir = readdirSync(store).find((d) => d.startsWith("esbuild@"));
    if (!dir) throw new Error("esbuild not found; run `pnpm install`");
    return require(join(store, dir, "node_modules/esbuild/lib/main.js"));
  }
}

/** Rewrite `./foo.js` → `./foo.ts` when only the .ts exists (TS/NodeNext convention). */
const tsExtensionPlugin = {
  name: "ts-js-extension",
  setup(b) {
    b.onResolve({ filter: /\.js$/ }, (args) => {
      if (args.kind === "entry-point" || !args.importer) return null;
      const asTs = resolve(args.resolveDir, args.path.replace(/\.js$/, ".ts"));
      if (existsSync(asTs)) return { path: asTs };
      return null;
    });
  },
};

// `@noble/{curves,hashes}/x` → the package's `./x.js` (v2 only exports the .js
// subpath). Resolve relative to the importer so the right version wins.
const nobleSubpathPlugin = {
  name: "noble-subpath",
  setup(b) {
    b.onResolve({ filter: /^@noble\/(curves|hashes)\/[^.]+$/ }, async (args) => {
      const r = await b.resolve(`${args.path}.js`, {
        kind: args.kind,
        importer: args.importer,
        resolveDir: args.resolveDir,
      });
      if (r.errors.length) return null;
      return { path: r.path, external: r.external };
    });
  },
};

// Bundle ONLY the packages node's strict ESM resolver chokes on: the workspace TS
// (`.js`→`.ts` convention) and @noble/@scure (strict export maps). Everything else
// — fastify & its CJS plugins (dynamic require), pg, prom-client,
// zod — node loads natively, so leave them external.
const BUNDLE_PREFIXES = ["@cixtech/", "@noble/", "@scure/"];
const externalizeRest = {
  name: "externalize-rest",
  setup(b) {
    b.onResolve({ filter: /.*/ }, (args) => {
      if (args.kind === "entry-point") return null;
      if (args.path.startsWith("node:")) return { external: true, path: args.path };
      if (args.path.startsWith(".") || isAbsolute(args.path)) return null;
      if (BUNDLE_PREFIXES.some((p) => args.path.startsWith(p))) return null; // bundle it
      return { external: true, path: args.path }; // fastify, pg, prom-client, zod, …
    });
  },
};

/** Bundle `src/<entry>.ts` to `.<entry>.bundle.mjs` and return the output path. */
export async function bundle(entry) {
  const { build } = loadEsbuild();
  const outfile = resolve(here, `.${entry}.bundle.mjs`);
  await build({
    entryPoints: [resolve(here, `src/${entry}.ts`)],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    plugins: [externalizeRest, nobleSubpathPlugin, tsExtensionPlugin],
    logLevel: "warning",
  });
  return outfile;
}
