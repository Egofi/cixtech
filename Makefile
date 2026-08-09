# cixtech — task runner.
#
#   make            list every target
#   make setup      install deps, then migrate the database
#   make dev        run the engine
#   make test       run the whole suite (no database setup needed)
#
# Everything here wraps the underlying pnpm/turbo scripts; nothing is Make-only,
# so `pnpm test` etc. still work if you prefer them.

SHELL := /usr/bin/env bash
.SHELLFLAGS := -euo pipefail -c
.DEFAULT_GOAL := help
MAKEFLAGS += --no-print-directory

# Repo-root .env, loaded by the node runners (see apps/api/bundle.mjs).
ENV_FILE := .env
# Values copied verbatim from .env.example — the same markers the code rejects.
PLACEHOLDERS := ep-REPLACE|ep-xxx|:PASSWORD@|://OWNER:|user:pass@

BASE_URL ?= http://localhost:3000
# `make test PKG=ledger` scopes to one workspace package.
PKG ?=

.PHONY: help setup install clean reset dev smoke urls \
        db-migrate db-role db-check verify-chains \
        test test-watch test-live typecheck lint format guard ci

# ─────────────────────────────────────────────────────────────────────────────
help: ## Show this help
	@printf "\n\033[1mcixtech\033[0m — licensed multi-tenant custody engine\n\n"
	@awk 'BEGIN {FS = ":.*##"} \
		/^##@/ { printf "\n\033[1m%s\033[0m\n", substr($$0, 5); next } \
		/^[a-zA-Z0-9_-]+:.*##/ { printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2 }' $(MAKEFILE_LIST)
	@printf "\n  Scope tests to one package:  \033[36mmake test PKG=ledger\033[0m\n\n"

##@ Setup

install: ## Install workspace dependencies
	pnpm install

setup: install db-migrate ## Install dependencies and migrate the database
	@printf "\n\033[32mReady.\033[0m Run \033[36mmake dev\033[0m to start the engine.\n"

clean: ## Remove build output, caches, and test database clusters
	rm -rf .turbo .test-postgres
	rm -f apps/api/*.bundle.mjs
	find . -name dist -type d -not -path "./node_modules/*" -prune -exec rm -rf {} +
	find . -name "*.tsbuildinfo" -not -path "./node_modules/*" -delete

reset: clean ## Clean, then reinstall from scratch
	rm -rf node_modules
	$(MAKE) install

##@ Run

dev: check-env ## Start the engine (reads .env; requires a migrated database)
	pnpm dev

smoke: ## Exercise the running engine end to end (start `make dev` first)
	@curl -sf $(BASE_URL)/health >/dev/null 2>&1 || { \
		printf "\033[31mNo engine at $(BASE_URL).\033[0m Start it with \`make dev\` first.\n"; \
		exit 1; \
	}
	BASE_URL=$(BASE_URL) bash apps/api/smoke.sh

urls: ## Print the engine's browsable endpoints
	@printf "\n  API docs (Scalar)  %s/docs\n" "$(BASE_URL)"
	@printf "  Tenant portal      %s/portal\n" "$(BASE_URL)"
	@printf "  Admin console      %s/admin      (Bearer CIXTECH_ADMIN_TOKEN)\n" "$(BASE_URL)"
	@printf "  Health / readiness %s/health  %s/ready\n" "$(BASE_URL)" "$(BASE_URL)"
	@printf "  Metrics            %s/metrics\n\n" "$(BASE_URL)"

##@ Database (ADR 0013)

db-migrate: check-env ## Apply schemas; verify RLS and connection pooling
	pnpm db:migrate

db-role: check-env ## Provision the least-privileged app role (prints its URL once)
	pnpm db:migrate --create-app-role

db-check: check-env ## Report whether .env is usable (no placeholders, URL present)
	@printf "\033[32m.env looks usable.\033[0m Run \033[36mmake db-migrate\033[0m to apply the schema.\n"

##@ Test

# The suite starts its own real PostgreSQL (embedded, no Docker, no DATABASE_URL).
test: ## Run the full test suite
ifeq ($(strip $(PKG)),)
	pnpm test
else
	pnpm --filter @cixtech/$(PKG) test
endif

test-watch: ## Re-run a package's tests on change (needs PKG=<name>)
	@test -n "$(strip $(PKG))" || { printf "\033[31mSet PKG=<name>\033[0m, e.g. make test-watch PKG=ledger\n"; exit 1; }
	pnpm --filter @cixtech/$(PKG) exec vitest

test-live: ## Run the network-gated live-chain suites (real testnet calls)
	@printf "These hit Tron Nile over the network and are skipped by default.\n"
	@printf "Enable per suite: CIXTECH_LIVE_NILE, CIXTECH_LIVE_PAYOUT, CIXTECH_LIVE_HD,\n"
	@printf "CIXTECH_LIVE_GUARDED, TRONGRID_API_KEY.\n\n"
	CIXTECH_LIVE_NILE=1 pnpm --filter @cixtech/chains test

##@ Quality

typecheck: ## Type-check every package
	pnpm typecheck

lint: ## Check formatting and lint rules (no writes)
	pnpm exec biome check .

format: ## Apply formatting and safe lint fixes
	pnpm check

guard: ## Fail on a hardcoded chain id / address / RPC URL (§16.5)
	pnpm guard:constants

verify-chains: ## Ask each configured chain to confirm its own id and token contracts
	pnpm verify:chains

ci: typecheck lint guard test ## Everything CI runs

# ─────────────────────────────────────────────────────────────────────────────
# Internal: fail early, with the fix, rather than letting the driver emit a DNS
# error. Mirrors the placeholder check in @cixtech/postgres.
.PHONY: check-env
check-env:
	@test -f $(ENV_FILE) || { \
		printf "\033[31mMissing $(ENV_FILE).\033[0m\n  cp .env.example .env   then fill in your Postgres URLs.\n"; \
		exit 1; \
	}
	@grep -qE '^[[:space:]]*(export[[:space:]]+)?(DATABASE_URL|DB_URL)=' $(ENV_FILE) || { \
		printf "\033[31mNo DATABASE_URL in $(ENV_FILE).\033[0m Postgres is required; there is no embedded fallback.\n"; \
		exit 1; \
	}
	@# `|| true`: with pipefail, the inner grep exits 1 when there is nothing to
	@# report — which is the SUCCESS case — and would abort the recipe silently.
	@offenders=$$({ grep -vE '^[[:space:]]*#' $(ENV_FILE) \
		| grep -E '$(PLACEHOLDERS)' \
		| sed -E 's/^[[:space:]]*(export[[:space:]]+)?([A-Za-z0-9_]+)=.*/\2/' \
		| paste -sd', ' -; } || true); \
	if [ -n "$$offenders" ]; then \
		printf "\033[31m$(ENV_FILE): still a placeholder from .env.example → \033[1m%s\033[0m\n" "$$offenders"; \
		printf "  Replace it with a real connection string, or comment the line out if optional.\n"; \
		printf "  (DIRECT_DATABASE_URL is optional — it falls back to DATABASE_URL.)\n"; \
		exit 1; \
	fi
