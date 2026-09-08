// Ahead-of-time build for the two runtime images.
//
//   pnpm build            → dist/{api,worker,migrate}.mjs
//
// One codebase, three entry points, two Dockerfiles. The API and the worker share
// every module under src/ — the ledger, the chain adapters, the pool — and that
// sharing is the whole reason they live in one workdir: the process that CREDITS a
// deposit and the process that DEBITS a payout must agree about double-entry
// accounting, and the surest way to guarantee that is for them to run the same code.
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { bundleFile } from "./bundle.mjs";

const here = import.meta.dirname;
const outDir = resolve(here, "dist");
mkdirSync(outDir, { recursive: true });

const ENTRIES = [
  ["api", "src/api/server.ts"],
  ["worker", "src/worker/main.ts"],
  ["migrate", "src/api/migrate.ts"],
];

for (const [name, entry] of ENTRIES) {
  const out = await bundleFile(resolve(here, entry), resolve(outDir, `${name}.mjs`));
  console.log(`[build] ${name.padEnd(8)} ${entry} → ${out.replace(`${here}/`, "")}`);
}
