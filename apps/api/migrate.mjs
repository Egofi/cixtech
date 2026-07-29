// Schema migration runner: load env, bundle src/migrate.ts, run it.
//
//   pnpm db:migrate            (from the repo root)
//   node apps/api/migrate.mjs
//
// Reads DATABASE_URL / DB_URL (and optional DIRECT_DATABASE_URL) from the repo
// root .env or the real environment. See src/migrate.ts for what it does.
import { pathToFileURL } from "node:url";
import { bundle, loadEnv } from "./bundle.mjs";

loadEnv();
const out = await bundle("migrate");
await import(pathToFileURL(out).href);
