SHELL := /usr/bin/env bash
.SHELLFLAGS := -euo pipefail -c
.DEFAULT_GOAL := help
MAKEFLAGS += --no-print-directory

ENV_FILE := .env
PLACEHOLDERS := ep-REPLACE|ep-xxx|:PASSWORD@|://OWNER:|user:pass@|REPLACE_ME

BASE_URL ?= http://localhost:3000
WEB_URL  ?= http://localhost:8080
PKG ?=

.PHONY: help setup install clean reset dev dev-worker dev-web smoke urls \
        images up down \
        db-migrate db-role db-check db-types verify-chains \
        test test-watch test-live typecheck lint format guard ci

help: ## Show this help
	@printf "\n\033[1mcixtech\033[0m - licensed multi-tenant custody engine\n\n"
	@awk 'BEGIN {FS = ":.*##"} \
		/^##@/ { printf "\n\033[1m%s\033[0m\n", substr($$0, 5); next } \
		/^[a-zA-Z0-9_-]+:.*##/ { printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2 }' $(MAKEFILE_LIST)
	@printf "\n  Scope tests to one module:  \033[36mmake test PKG=ledger\033[0m\n\n"

##@ Setup

install: ## Install workspace dependencies
	pnpm install

setup: install db-migrate ## Install dependencies and migrate the database
	@printf "\n\033[32mReady.\033[0m Run \033[36mmake dev\033[0m to start the engine.\n"

clean: ## Remove build output, caches, and test database clusters
	rm -rf .test-postgres dist
	rm -f .dev-*.mjs
	find . -name dist -type d -not -path "./node_modules/*" -prune -exec rm -rf {} +
	find . -name "*.tsbuildinfo" -not -path "./node_modules/*" -delete

reset: clean ## Clean, then reinstall from scratch
	rm -rf node_modules
	$(MAKE) install

##@ Run

dev: check-env ## Start the backend API (reads .env; requires a migrated database)
	pnpm dev

dev-worker: check-env ## Start the background worker (deposit detection, webhooks, reconcile)
	pnpm dev:worker

dev-web: ## Run the consoles on :8080 with hot reload (Next dev server)
	@cd ../frontend && pnpm dev

##@ Docker (three independently deployable images)

images: ## Build all three images
	docker build -f Dockerfile.api    -t cixtech-api .
	docker build -f Dockerfile.worker -t cixtech-worker .
	cd ../frontend && docker build -t cixtech-web .

up: ## Start the whole stack (postgres, redis, api, worker, web)
	@$(MAKE) -C .. up

down: ## Stop the stack, keeping volumes
	@$(MAKE) -C .. down

smoke: ## Exercise the running engine end to end (start `make dev` first)
	@curl -sf $(BASE_URL)/health >/dev/null 2>&1 || { \
		printf "\033[31mNo engine at $(BASE_URL).\033[0m Start it with \`make dev\` first.\n"; \
		exit 1; \
	}
	BASE_URL=$(BASE_URL) bash smoke.sh

urls: ## Print the browsable endpoints of all three services
	@printf "\n  \033[1mBackend\033[0m  (backend, Dockerfile.api - HTTP only)\n"
	@printf "    API docs (Scalar)  %s/docs\n" "$(BASE_URL)"
	@printf "    Health / readiness %s/health  %s/ready\n" "$(BASE_URL)" "$(BASE_URL)"
	@printf "    Metrics            %s/metrics  (Bearer CIXTECH_ADMIN_TOKEN)\n" "$(BASE_URL)"
	@printf "\n  \033[1mFrontend\033[0m (frontend/ - deployed separately)\n"
	@printf "    Tenant portal      %s/portal/\n" "$(WEB_URL)"
	@printf "    Admin console      %s/admin/   (sign in; see pnpm create-operator)\n" "$(WEB_URL)"
	@printf "\n  \033[1mWorker\033[0m   (backend, Dockerfile.worker - detection, webhooks, reconcile)\n"
	@printf "    Health             http://localhost:3001/\n\n"

##@ Database (ADR 0013)

db-migrate: check-env ## Apply schemas; verify RLS and connection pooling
	pnpm db:migrate

db-role: check-env ## Provision the least-privileged app role (prints its URL once)
	pnpm db:migrate --create-app-role

db-check: check-env ## Report whether .env is usable (no placeholders, URL present)
	@printf "\033[32m.env looks usable.\033[0m Run \033[36mmake db-migrate\033[0m to apply the schema.\n"

##@ Test

test: ## Run the full test suite
ifeq ($(strip $(PKG)),)
	pnpm test
else
	npx vitest run test/$(PKG)
endif

test-watch: ## Re-run one module's tests on change (needs PKG=<name>)
	@test -n "$(strip $(PKG))" || { printf "\033[31mSet PKG=<name>\033[0m, e.g. make test-watch PKG=ledger\n"; exit 1; }
	npx vitest test/$(PKG)

test-live: ## Run the network-gated live-chain suites (real testnet calls)
	@printf "These hit Tron Nile over the network and are skipped by default.\n"
	@printf "Enable per suite: CIXTECH_LIVE_NILE, CIXTECH_LIVE_PAYOUT, CIXTECH_LIVE_HD,\n"
	@printf "CIXTECH_LIVE_GUARDED, TRONGRID_API_KEY.\n\n"
	CIXTECH_LIVE_NILE=1 npx vitest run test/chains

##@ Quality

typecheck: ## Type-check every package
	pnpm typecheck

lint: ## Check formatting and lint rules (no writes)
	pnpm exec biome check .

format: ## Apply formatting and safe lint fixes
	pnpm lint

guard: ## Fail on a hardcoded contract address or RPC URL (spec 16.5)
	pnpm guard:constants

db-types: ## Fail if types/ports/db.ts has drifted from src/schemas/sql
	pnpm db:types:check

verify-chains: ## Ask each configured chain to confirm its own id and token contracts
	pnpm verify:chains

ci: db-types typecheck lint guard test ## Everything CI runs (same order as `pnpm check`)

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
	@# report - which is the SUCCESS case - and would abort the recipe silently.
	@offenders=$$({ grep -vE '^[[:space:]]*#' $(ENV_FILE) \
		| grep -E '$(PLACEHOLDERS)' \
		| sed -E 's/^[[:space:]]*(export[[:space:]]+)?([A-Za-z0-9_]+)=.*/\2/' \
		| paste -sd', ' -; } || true); \
	if [ -n "$$offenders" ]; then \
		printf "\033[31m$(ENV_FILE): still a placeholder from .env.example -> \033[1m%s\033[0m\n" "$$offenders"; \
		printf "  Replace it with a real connection string, or comment the line out if optional.\n"; \
		printf "  (DIRECT_DATABASE_URL is optional - it falls back to DATABASE_URL.)\n"; \
		exit 1; \
	fi
