// esbuild bundler for the backend's two entry points (API server, worker) plus
// the migration runner.
//
// Node's ESM resolver cannot follow this codebase's `.js`-importing-`.ts`
// convention, nor the `@/…` module aliases, so `node src/api/server.ts` will never
// work directly. These plugins are what turn the source into something plain
// `node` can run — which is what the Dockerfiles execute.
import { existsSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const root = import.meta.dirname;

// esbuild is a transitive (pnpm) dep — resolve it from the store if not linked.
function loadEsbuild() {
  try {
    return require("esbuild");
  } catch {
    const store = resolve(root, "node_modules/.pnpm");
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

// Bundle ONLY what node's strict ESM resolver chokes on: our own aliased modules
// (`@/…`, `.js`→`.ts`) and @noble/@scure (strict export maps). Everything else —
// fastify and its CJS plugins (dynamic require), pg, prom-client, zod — node loads
// natively, so leave it external and let node_modules serve it at runtime.
const BUNDLE_PREFIXES = ["@/", "@test/", "@noble/", "@scure/"];
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

/**
 * Resolve the `@/…` and `@test/…` aliases declared in tsconfig.json.
 *
 * esbuild does read tsconfig `paths`, but only for files it already considers
 * part of the project; doing it explicitly here means the bundle and the
 * typechecker cannot disagree about where a module lives, which is the failure
 * mode that produces a build that compiles and then throws at import time.
 */
const aliasPlugin = {
  name: "module-alias",
  setup(b) {
    /**
     * Resolve one alias to a real FILE.
     *
     * The order matters and the isFile() check is load-bearing: `@/errors` maps to
     * `src/errors`, which exists — as a directory. Accepting it because it exists
     * hands esbuild a directory to read, so every module-index import fails. Try
     * the file forms first, and only ever return something that is genuinely a file.
     */
    const resolveIn = (base, rel) => {
      const stripped = rel.replace(/\.js$/, "");
      for (const candidate of [
        resolve(base, `${stripped}.ts`),
        resolve(base, stripped, "index.ts"),
        resolve(base, rel),
      ]) {
        if (existsSync(candidate) && statSync(candidate).isFile()) return { path: candidate };
      }
      return null;
    };

    b.onResolve({ filter: /^@\/types$/ }, () => ({ path: resolve(root, "types/index.ts") }));
    b.onResolve({ filter: /^@\/types\// }, (args) =>
      resolveIn(resolve(root, "types"), args.path.slice("@/types/".length)),
    );
    b.onResolve({ filter: /^@\// }, (args) => resolveIn(resolve(root, "src"), args.path.slice(2)));
    b.onResolve({ filter: /^@test\// }, (args) =>
      resolveIn(resolve(root, "test"), args.path.slice("@test/".length)),
    );
  },
};

/** Bundle a TypeScript entry point to a runnable ESM file. */
export async function bundleFile(entryPoint, outfile) {
  const { build } = loadEsbuild();
  await build({
    entryPoints: [entryPoint],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    plugins: [aliasPlugin, externalizeRest, nobleSubpathPlugin, tsExtensionPlugin],
    logLevel: "warning",
  });
  return outfile;
}
