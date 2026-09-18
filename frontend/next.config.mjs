// `next dev` and `next build` want opposite things here.
//
// The build is a static export served by nginx, which does the API proxying in
// production (see nginx.conf + docker-entrypoint.sh). `output: "export"` cannot
// carry rewrites, and Next warns if both are set.
//
// The dev server has no nginx in front of it, so it does the proxying itself.
// That keeps one behaviour in both modes: the console always calls relative
// URLs on its own origin, and never learns the API's address.
const DEV = process.env.NODE_ENV === "development";

// Where the dev server forwards to. Host-to-container, unlike the compose
// default, because `pnpm dev` runs on the host.
const API_UPSTREAM = (process.env.CIXTECH_API_UPSTREAM ?? "http://127.0.0.1:3000").replace(
  /\/+$/,
  "",
);

// The three prefixes the consoles call, plus the API reference. Anything else on
// this origin is a console page and must not be forwarded -- note that
// `/admin/api/` is proxied while `/admin/` itself is a Next route.
const PROXIED = ["/v1", "/auth", "/admin/api", "/docs"];

const nextConfig = {
  ...(DEV ? {} : { output: "export" }),

  trailingSlash: true,

  images: { unoptimized: true },

  eslint: { ignoreDuringBuilds: true },

  // `trailingSlash: true` shapes the static export (admin/audit/index.html), but
  // in dev it also 308s every request without one -- including /v1/chains, which
  // `fetch` then follows to /v1/chains/ and the API answers 404. A 308 keeps the
  // method and body, so a POST fails the same silent way. Rewrites are matched
  // after that redirect, so the proxy never saw the request at all.
  //
  // Only in dev: the export still wants the redirect, and nginx serves it there.
  ...(DEV ? { skipTrailingSlashRedirect: true } : {}),

  ...(DEV
    ? {
        async rewrites() {
          // `beforeFiles`, not a bare array. An array is applied AFTER filesystem
          // and page routes, so the App Router answered /v1/... with the console's
          // own HTML shell and the proxy never ran. These prefixes belong to the
          // API and must win before Next looks for a page.
          return {
            beforeFiles: [
              ...PROXIED.map((prefix) => ({
                source: `${prefix}/:path*`,
                destination: `${API_UPSTREAM}${prefix}/:path*`,
              })),
              // Also requested without a trailing segment, e.g. GET /docs.
              ...PROXIED.map((prefix) => ({
                source: prefix,
                destination: `${API_UPSTREAM}${prefix}`,
              })),
            ],
          };
        },
      }
    : {}),
};

export default nextConfig;
