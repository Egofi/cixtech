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
  // Bundled so the first operator can be created inside the api container,
  // without publishing Postgres to the host just to run a one-off.
  ["create-operator", "src/api/create-operator-cli.ts"],
];

for (const [name, entry] of ENTRIES) {
  const out = await bundleFile(resolve(here, entry), resolve(outDir, `${name}.mjs`));
  console.log(`[build] ${name.padEnd(8)} ${entry} → ${out.replace(`${here}/`, "")}`);
}
