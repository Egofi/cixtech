// Ahead-of-time build for the production image.
//
//   pnpm --filter @cixtech/api build:dist
//
// Same esbuild pipeline `dev-run.mjs` uses, but run once at IMAGE BUILD time and
// written to `dist/` instead of a hidden scratch bundle beside the source. The
// runtime image then needs neither esbuild nor the TypeScript sources — it runs
// `node dist/server.mjs` with production dependencies only, which is what lets
// the final stage drop the dev toolchain and the repo tree.
//
// Deliberately does NOT call loadEnv(): a build must never read a developer's
// .env, and nothing about the bundle depends on configuration.
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bundleTo } from "./bundle.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, "dist");
mkdirSync(outDir, { recursive: true });

for (const entry of ["server", "migrate"]) {
  const out = resolve(outDir, `${entry}.mjs`);
  await bundleTo(entry, out);
  console.log(`[build] ${entry} → ${out.replace(`${here}/`, "")}`);
}
