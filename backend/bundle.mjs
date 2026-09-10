import { existsSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const root = import.meta.dirname;

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

const BUNDLE_PREFIXES = ["@/", "@test/", "@noble/", "@scure/"];
const externalizeRest = {
  name: "externalize-rest",
  setup(b) {
    b.onResolve({ filter: /.*/ }, (args) => {
      if (args.kind === "entry-point") return null;
      if (args.path.startsWith("node:")) return { external: true, path: args.path };
      if (args.path.startsWith(".") || isAbsolute(args.path)) return null;
      if (BUNDLE_PREFIXES.some((p) => args.path.startsWith(p))) return null;
      return { external: true, path: args.path };
    });
  },
};

const aliasPlugin = {
  name: "module-alias",
  setup(b) {
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
