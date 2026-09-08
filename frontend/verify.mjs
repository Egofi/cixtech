// Checks on the exported console bundle, run as `pnpm test` after `next build`.
//
// TypeScript covers the source; these cover the OUTPUT, where a different class
// of mistake lives. Each assertion is a failure that ships silently otherwise:
//
//   * a missing route        → a nav link that 404s in production only
//   * an inlined API base    → one image per environment, and a promoted image
//                              still pointing at the environment it was built for
//   * config.js absent/late  → window.CIXTECH undefined when the first request
//                              fires, so every call goes to the static host
//   * a leaked secret        → anything credential-shaped baked into a public bundle
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "out");

const failures = [];
const check = (ok, msg) => {
  if (!ok) failures.push(msg);
};

function walk(dir, acc = []) {
  for (const e of readdirSync(dir)) {
    const full = join(dir, e);
    if (statSync(full).isDirectory()) walk(full, acc);
    else acc.push(full);
  }
  return acc;
}

let files;
try {
  files = walk(out);
} catch {
  console.error("[web] out/ does not exist — run `next build` first");
  process.exit(1);
}

// ── Every route the navigation links to must exist as a real page ────────────
const ROUTES = [
  "index.html",
  "admin/index.html",
  "admin/tenants/index.html",
  "admin/pools/index.html",
  "admin/ledger/index.html",
  "admin/deposits/index.html",
  "admin/payouts/index.html",
  "admin/earnings/index.html",
  "admin/webhooks/index.html",
  "admin/audit/index.html",
  "admin/errors/index.html",
  "portal/index.html",
  "portal/accounts/index.html",
  "portal/deposits/index.html",
  "portal/payouts/index.html",
  "portal/allowlist/index.html",
  "portal/webhooks/index.html",
  "portal/ai/index.html",
];
for (const route of ROUTES) {
  const path = join(out, route);
  let body = "";
  try {
    body = readFileSync(path, "utf8");
  } catch {
    check(false, `missing route: ${route}`);
    continue;
  }
  check(body.includes("<html"), `${route}: not an HTML document`);
  // config.js must be requested by every page that will call the API.
  check(body.includes("/config.js"), `${route}: does not load /config.js`);
}

// ── Runtime config, not build-time ───────────────────────────────────────────
const config = readFileSync(join(out, "config.js"), "utf8");
check(config.includes("window.CIXTECH"), "config.js: does not define window.CIXTECH");

// A NEXT_PUBLIC_ API base would be inlined into the JS chunks, which is exactly
// the thing this design avoids. Nothing in the bundle may reference one.
const scripts = files.filter((f) => f.endsWith(".js"));
for (const f of scripts) {
  const body = readFileSync(f, "utf8");
  const rel = f.slice(out.length + 1);
  check(
    !body.includes("NEXT_PUBLIC_CIXTECH_API_BASE"),
    `${rel}: API base inlined at build time — it must come from config.js at runtime`,
  );
}

// ── No credential-shaped strings in a bundle served to the public ────────────
const SECRET_SHAPES = [
  [/\bcxk_[0-9a-f]{16,}/, "tenant API key (cxk_…)"],
  [/\bcxs_[0-9a-f]{16,}/, "webhook secret (cxs_…)"],
  [/\bxprv[1-9A-HJ-NP-Za-km-z]{50,}/, "extended private key (xprv…)"],
];
for (const f of [...scripts, ...files.filter((x) => x.endsWith(".html"))]) {
  const body = readFileSync(f, "utf8");
  const rel = f.slice(out.length + 1);
  for (const [shape, what] of SECRET_SHAPES) {
    check(!shape.test(body), `${rel}: contains something shaped like a ${what}`);
  }
}

// ── The CSP allows inline script (Next's RSC bootstrap leaves no choice on a
// static export), so React's default escaping is what stands between a hostile
// API response and script execution. dangerouslySetInnerHTML removes that, which
// is why its presence fails the build rather than being caught in review.
for (const dir of ["app", "components", "lib"]) {
  let sources = [];
  try {
    sources = walk(join(here, dir));
  } catch {
    continue;
  }
  for (const f of sources.filter((x) => /\.tsx?$/.test(x))) {
    const body = readFileSync(f, "utf8");
    check(
      !body.includes("dangerouslySetInnerHTML"),
      `${f.slice(here.length + 1)}: uses dangerouslySetInnerHTML — the CSP permits inline script, so React's escaping is load-bearing`,
    );
  }
}

if (failures.length > 0) {
  console.error(`[web] ${failures.length} check(s) failed:`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`[web] ${ROUTES.length} routes and ${files.length} files verified`);
