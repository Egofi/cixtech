// Dev runner: load .env.dev, bundle the API server (workspace TypeScript + its npm
// deps) with esbuild, then run it. No global installs — esbuild ships with the
// repo's test tooling. Env is read by src/server.ts (CIXTECH_ENGINE_XPRV, …).
//
//   node apps/api/dev-run.mjs
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// Load env from an .env file (CIXTECH_ENV_FILE, else .env.dev) so `pnpm dev` needs
// no manual exports. `export KEY=value` and `KEY=value` are both accepted; a value
// already present in process.env wins (real env overrides the file).
function loadEnvFile() {
  const file = resolve(here, process.env["CIXTECH_ENV_FILE"] ?? ".env.dev");
  if (!existsSync(file)) return;
  for (const raw of readFileSync(file, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.replace(/^export\s+/, "").match(/^([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    const value = m[2].replace(/^["']|["']$/g, "");
    if (process.env[key] === undefined) process.env[key] = value;
  }
  console.log(`[dev] loaded env from ${file}`);
}
loadEnvFile();

// esbuild is a transitive (pnpm) dep — resolve it from the store if not linked.
function loadEsbuild() {
  try {
    return require("esbuild");
  } catch {
    const store = resolve(here, "../../node_modules/.pnpm");
    const dir = readdirSync(store).find((d) => d.startsWith("esbuild@"));
    if (!dir) throw new Error("esbuild not found; run `pnpm install`");
    return require(join(store, dir, "node_modules/esbuild/lib/main.js"));
  }
}
const { build } = loadEsbuild();

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
// — fastify & its CJS plugins (dynamic require), pglite (WASM), prom-client, zod —
// node loads natively, so leave them external.
const BUNDLE_PREFIXES = ["@cixtech/", "@noble/", "@scure/"];
const externalizeRest = {
  name: "externalize-rest",
  setup(b) {
    b.onResolve({ filter: /^[^./]/ }, (args) => {
      if (args.path.startsWith("node:")) return { external: true, path: args.path };
      if (BUNDLE_PREFIXES.some((p) => args.path.startsWith(p))) return null; // bundle it
      return { external: true, path: args.path }; // fastify, pglite, prom-client, zod, …
    });
  },
};

const out = resolve(here, ".dev-server.mjs");
await build({
  entryPoints: [resolve(here, "src/server.ts")],
  outfile: out,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  plugins: [externalizeRest, nobleSubpathPlugin, tsExtensionPlugin],
  logLevel: "warning",
});

await import(pathToFileURL(out).href);
