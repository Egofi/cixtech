# Multi-stage Dockerfile for cixtech crypto-custody engine
FROM node:20-alpine AS base

WORKDIR /app

# Install build tools & enable Corepack for pnpm
RUN apk add --no-cache bash curl && \
    corepack enable && \
    corepack prepare pnpm@9.15.4 --activate

# Copy package manifests and workspace configuration
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc turbo.json tsconfig.base.json ./
COPY apps/api/package.json ./apps/api/
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

# Install workspace dependencies.
#
# --frozen-lockfile, not --no-frozen-lockfile: with shamefully-hoist=true exactly
# ONE @noble/curves lands in the root node_modules, and the repo declares two
# majors (root ^2.2.0, packages/{signing,chains,mpc} ^1.7.0). Re-resolving on
# every build lets that hoist flip between majors — v2 dropped the extensionless
# "@noble/curves/secp256k1" subpath export, so a build that hoists v2 fails
# typecheck while the previous one passed. The lockfile pins signing to 1.9.7;
# honour it, and let a genuinely stale lockfile fail the build loudly.
RUN pnpm install --frozen-lockfile

# Copy all source files and tooling
COPY apps ./apps
COPY packages ./packages
COPY tooling ./tooling
COPY docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

# Typecheck workspace packages
RUN pnpm typecheck

# Expose HTTP API port
EXPOSE 3000

# Set entrypoint and default execution command
ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["node", "apps/api/dev-run.mjs"]
