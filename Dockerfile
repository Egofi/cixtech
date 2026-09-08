# Multi-stage Dockerfile for the cixtech crypto-custody engine.
#
# Three stages, for two security reasons:
#
#   1. The runtime image carries production dependencies and two bundled entry
#      points — not the TypeScript sources, not the test suite, not the dev
#      toolchain. A smaller surface is fewer things an attacker can reach, and
#      the engine no longer compiles its own code at boot.
#   2. It runs as a NON-ROOT user. This process holds the master signing key in
#      memory; running it as uid 0 means any code-execution bug is also a
#      container escape primitive and can read every other process's environment.
#
# Build: docker build -t cixtech-api .
FROM node:20-alpine AS base
WORKDIR /app
RUN apk add --no-cache bash curl && \
    corepack enable && \
    corepack prepare pnpm@9.15.4 --activate

# ── deps ────────────────────────────────────────────────────────────────────────
# Manifests only, so a source-only change reuses this layer.
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc turbo.json tsconfig.base.json ./
COPY apps/api/package.json ./apps/api/
COPY apps/worker/package.json ./apps/worker/
COPY packages/ai/package.json ./packages/ai/
COPY packages/attribution/package.json ./packages/attribution/
COPY packages/chain-config/package.json ./packages/chain-config/
COPY packages/chains/package.json ./packages/chains/
COPY packages/errors/package.json ./packages/errors/
COPY packages/ledger/package.json ./packages/ledger/
COPY packages/mpc/package.json ./packages/mpc/
COPY packages/postgres/package.json ./packages/postgres/
COPY packages/signing/package.json ./packages/signing/
COPY packages/testing/package.json ./packages/testing/
COPY packages/types/package.json ./packages/types/

# --frozen-lockfile, not --no-frozen-lockfile: with shamefully-hoist=true exactly
# ONE @noble/curves lands in the root node_modules, and the repo declares two
# majors (root ^2.2.0, packages/{signing,chains,mpc} ^1.7.0). Re-resolving on
# every build lets that hoist flip between majors — v2 dropped the extensionless
# "@noble/curves/secp256k1" subpath export, so a build that hoists v2 fails
# typecheck while the previous one passed. The lockfile pins signing to 1.9.7;
# honour it, and let a genuinely stale lockfile fail the build loudly.
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

# ── build ───────────────────────────────────────────────────────────────────────
FROM deps AS build
COPY apps ./apps
COPY packages ./packages
COPY tooling ./tooling
RUN pnpm typecheck
# Bundle the server and the migration runner ahead of time (apps/api/build.mjs).
RUN pnpm --filter @cixtech/api build:dist

# Production dependency tree for the runtime stage — no esbuild, no vitest, no tsc.
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --prod --ignore-scripts

# ── runtime ─────────────────────────────────────────────────────────────────────
FROM base AS runtime
ENV NODE_ENV=production

# A dedicated unprivileged account. node:20-alpine ships uid 1000 `node`; using it
# keeps file ownership predictable across the COPY --chown lines below.
RUN mkdir -p /app && chown node:node /app
WORKDIR /app

COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/apps/api/dist ./apps/api/dist
COPY --chown=node:node docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

USER node

EXPOSE 3000

# Fail fast rather than restart-looping on a half-broken process.
HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=5 \
  CMD curl -fsS http://127.0.0.1:3000/health || exit 1

ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["node", "apps/api/dist/server.mjs"]
