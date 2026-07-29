// Dev runner: load env, bundle the API server (workspace TypeScript + its npm
// deps) with esbuild, then run it.
//
//   pnpm dev
//   node apps/api/dev-run.mjs
//
// Env comes from apps/api/.env.dev and the repo-root .env (CIXTECH_ENGINE_XPRV,
// DATABASE_URL, …) — see bundle.mjs for precedence.
import { pathToFileURL } from "node:url";
import { bundle, loadEnv } from "./bundle.mjs";

loadEnv();
const out = await bundle("server");
await import(pathToFileURL(out).href);
