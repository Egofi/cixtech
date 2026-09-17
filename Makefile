SHELL := /usr/bin/env bash
.SHELLFLAGS := -euo pipefail -c
.DEFAULT_GOAL := help
MAKEFLAGS += --no-print-directory

# Two workdirs, three deployables (docs/DEPLOYMENT_TOPOLOGY.md). This file is the
# entry point for the whole repo; backend/Makefile owns everything that is purely
# backend, and is delegated to rather than duplicated.
BACKEND  := backend
FRONTEND := frontend
ENV_FILE := $(BACKEND)/.env

# Compose must run from the repo root, where docker-compose.yml lives.
#
# --env-file is passed explicitly rather than relying on COMPOSE_ENV_FILES in the
# root .env: Compose v2 (checked on 29.5.2) does NOT read COMPOSE_ENV_FILES back
# out of the .env file it is configuring itself from, only from the real
# environment. It went unnoticed while every interpolated variable still had a
# `:-default` to fall back on -- which meant api and worker were handed a
# DATABASE_URL built from the DEFAULT password while postgres initialised itself
# from the real one in backend/.env. Being explicit here removes the ambiguity.
COMPOSE     := docker compose --env-file $(ENV_FILE)
# The base file deliberately does not publish postgres or redis (CX-18). The dev
# overlay binds them to loopback only, and is never loaded unless passed with -f.
COMPOSE_DEV := $(COMPOSE) -f docker-compose.yml -f docker-compose.dev.yml
# Publishes only the API, for running the consoles on the host against Docker.
COMPOSE_APIPORT := $(COMPOSE) -f docker-compose.yml -f docker-compose.api-port.yml

API_URL ?= http://localhost:3000
WEB_URL ?= http://localhost:8080

.PHONY: help doctor setup env key address operator tenant-key install \
        services services-down dev migrate api worker web \
        up up-dev up-backend down down-hard build logs requests requests-raw ps restart \
        test check lint typecheck check-web build-web \
        urls smoke clean reset check-secrets

help: ## Show this help
	@printf "\n\033[1mcixtech\033[0m - licensed multi-tenant custody engine\n"
	@printf "Two workdirs (%s, %s), three deployables.\n" "$(BACKEND)" "$(FRONTEND)"
	@awk 'BEGIN {FS = ":.*##"} \
		/^##@/ { printf "\n\033[1m%s\033[0m\n", substr($$0, 5); next } \
		/^[a-zA-Z0-9_-]+:.*##/ { printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2 }' $(MAKEFILE_LIST)
	@printf "\n  \033[1mFirst time:\033[0m  \033[36mmake setup\033[0m   then  \033[36mmake dev\033[0m\n"
	@printf "  \033[1mJust run it:\033[0m \033[36mmake up\033[0m      (everything in Docker)\n"
	@printf "  Backend-only targets:   \033[36mmake -C backend help\033[0m\n\n"

##@ Getting started

doctor: ## Check that the tools this repo needs are present
	@ok=0; \
	check() { \
		if command -v "$$1" >/dev/null 2>&1; then \
			printf "  \033[32mok\033[0m    %-8s %s\n" "$$1" "$$($$2 2>/dev/null | head -1)"; \
		else \
			printf "  \033[31mMISSING\033[0m %-8s %s\n" "$$1" "$$3"; ok=1; \
		fi; \
	}; \
	printf "\n"; \
	check node "node --version" "install Node >= 20"; \
	check pnpm "pnpm --version" "corepack enable"; \
	check docker "docker --version" "needed for postgres, redis and the full stack"; \
	printf "\n"; \
	if [ -f "$(ENV_FILE)" ]; then \
		printf "  \033[32mok\033[0m    %s exists\n\n" "$(ENV_FILE)"; \
	else \
		printf "  \033[33mtodo\033[0m  %s is missing - run \033[36mmake env\033[0m\n\n" "$(ENV_FILE)"; ok=1; \
	fi; \
	exit $$ok

env: ## Create backend/.env from the example (never overwrites an existing one)
	@if [ -f "$(ENV_FILE)" ]; then \
		printf "\033[33m$(ENV_FILE) already exists\033[0m - leaving it alone.\n"; \
	else \
		cp "$(BACKEND)/.env.example" "$(ENV_FILE)"; \
		printf "\033[32mCreated $(ENV_FILE).\033[0m Fill in the four secrets before starting:\n"; \
		printf "  POSTGRES_PASSWORD      any value; compose now refuses to boot without it\n"; \
		printf "  CIXTECH_ENGINE_XPRV    make key   (testnet only; see ADR 0007)\n"; \
		printf "  CIXTECH_ADMIN_TOKEN    openssl rand -hex 32\n"; \
		printf "  CIXTECH_POLICY_KEY     openssl rand -hex 32\n"; \
	fi

key: ## Generate a CIXTECH_ENGINE_XPRV for local dev / testnet
	@cd $(BACKEND) && pnpm generate-engine-key

address: ## Print the engine's address at an index (INDEX=1000000)
	@cd $(BACKEND) && pnpm derive-address $(or $(INDEX),1000000)

operator: ## Create an admin sign-in (EMAIL=you@example.com [ROLE=owner])
	@test -n "$(EMAIL)" || { \
		printf "\033[31mSet EMAIL.\033[0m  make operator EMAIL=you@example.com [ROLE=owner|operator|viewer]\n"; \
		printf "  owner    everything, including staff accounts and the fee sweep\n"; \
		printf "  operator kill switch, tenants, keys -- not staff, not treasury\n"; \
		printf "  viewer   read only (the only role without a TOTP requirement)\n"; \
		exit 1; \
	}
	@# Prefer the running container: it already reaches Postgres over the compose
	@# network, so this works under `make up`, where Postgres is not published.
	@# Falls back to the host script for someone running the API outside Docker.
	@if docker ps --filter "name=cixtech-api" --filter "status=running" --format '{{.Names}}' | grep -q cixtech-api; then \
		docker compose --env-file $(ENV_FILE) exec -T api \
			node dist/create-operator.mjs --email "$(EMAIL)" --role "$(or $(ROLE),owner)"; \
	else \
		printf "\033[33mcixtech-api is not running\033[0m - using the host script, which needs\n"; \
		printf "Postgres published (\033[36mmake up-dev\033[0m or \033[36mmake services\033[0m).\n\n"; \
		cd $(BACKEND) && pnpm create-operator --email "$(EMAIL)" --role "$(or $(ROLE),owner)"; \
	fi

tenant-key: ## Issue a tenant API key against the configured database
	@cd $(BACKEND) && pnpm generate-test-key

install: ## Install dependencies in both workdirs
	cd $(BACKEND) && pnpm install
	cd $(FRONTEND) && pnpm install

setup: env install services migrate ## Everything needed to go from clone to running
	@printf "\n\033[32mReady.\033[0m Start the three processes with \033[36mmake dev\033[0m,\n"
	@printf "or run the whole stack in Docker with \033[36mmake up\033[0m.\n\n"

##@ Run locally (host processes, dockerised datastores)

services: ## Start only postgres + redis, bound to loopback (dev overlay)
	$(COMPOSE_DEV) up -d postgres redis
	@printf "\n\033[32mpostgres :5432   redis :6380\033[0m\n"
	@printf "  Redis is on 6380, not 6379, so it cannot collide with another\n"
	@printf "  project's Redis and fail silently. $(ENV_FILE) must agree:\n"
	@printf "  \033[36mREDIS_URL=redis://127.0.0.1:6380\033[0m\n\n"

services-down: ## Stop postgres + redis, keeping their volumes
	$(COMPOSE_DEV) stop postgres redis

migrate: ## Apply the schema (the server will not run DDL itself)
	$(MAKE) -C $(BACKEND) db-migrate

dev: services migrate ## Prepare the datastores, then print the processes to start
	@printf "\n\033[1mStart these in three terminals:\033[0m\n\n"
	@printf "  \033[36mmake api\033[0m      API      :3000\n"
	@printf "  \033[36mmake worker\033[0m   worker   :3001   deposits are NOT credited without it\n"
	@printf "  \033[36mmake web\033[0m      consoles :8080\n\n"
	@printf "  They are separate targets rather than one backgrounded command so that\n"
	@printf "  Ctrl-C stops what you think it stops, and a crash is visible.\n\n"

api: ## Run the API in the foreground (:3000)
	$(MAKE) -C $(BACKEND) dev

worker: ## Run the background worker in the foreground (:3001)
	$(MAKE) -C $(BACKEND) dev-worker

web: ## Run the consoles with hot reload (:8080)
	cd $(FRONTEND) && pnpm dev

##@ Run everything in Docker

up: check-secrets ## Build and start the full stack; API reachable only through the console proxy
	$(COMPOSE) up -d --build
	@printf "\n\033[32mStack up.\033[0m Consoles and API are both on %s\n" "$(WEB_URL)"
	@printf "  The API is not published; the console proxies /v1, /auth, /admin/api and /docs.\n"
	@printf "  \033[36mmake logs\033[0m to follow, \033[36mmake urls\033[0m for the endpoints.\n\n"

up-dev: check-secrets ## Same, but also publish postgres, redis and the API on loopback
	$(COMPOSE_DEV) up -d --build
	@printf "\n\033[32mStack up (dev overlay).\033[0m API also on %s for curl and /docs.\n" "$(API_URL)"
	@printf "  X-Forwarded-For is NOT trusted in this mode -- see docker-compose.dev.yml.\n\n"

up-backend: check-secrets ## Datastores + API + worker in Docker, no web (for `make web` on the host)
	$(COMPOSE_APIPORT) up -d --build postgres redis api worker
	@printf "\n\033[32mBackend up.\033[0m API on 127.0.0.1:%s\n" "$(or $(CIXTECH_API_HOST_PORT),3000)"
	@printf "  Run the consoles on the host with \033[36mmake web\033[0m. Next proxies /v1, /auth,\n"
	@printf "  /admin/api and /docs to CIXTECH_API_UPSTREAM, which must name that port:\n"
	@printf "    \033[36mCIXTECH_API_UPSTREAM=http://127.0.0.1:%s\033[0m\n" "$(or $(CIXTECH_API_HOST_PORT),3000)"
	@printf "  If something else already holds it, set \033[36mCIXTECH_API_HOST_PORT\033[0m and\n"
	@printf "  point the upstream at the same number.\n\n"

down: ## Stop the stack, keeping volumes
	$(COMPOSE) down

down-hard: ## Stop the stack and DROP the database and redis volumes
	@printf "\033[31mThis deletes the database and redis volumes. Every ledger row goes with them.\033[0m\n"
	@# `|| reply=`: at EOF (a non-interactive shell, CI, a piped make) `read` exits
	@# non-zero, which under `set -e` would abort with a confusing error instead of
	@# simply declining. Refusing to drop is the right answer when nobody answered.
	@reply=""; read -r -p "Type 'drop' to confirm: " reply || reply=""; \
	if [ "$$reply" = "drop" ]; then \
		$(COMPOSE) down -v; \
	else \
		printf "Left alone.\n"; \
	fi

build: ## Build the three images without starting anything
	$(COMPOSE) build

logs: ## Follow the api and worker logs
	$(COMPOSE) logs -f api worker

requests: ## Watch every request and response hitting the API, live
	@printf "\033[2mmethod, path, status and duration as Fastify logs them. Ctrl-C to stop.\033[0m\n\n"
	@# --no-log-prefix keeps the container name off each line so the JSON parses.
	@# Fastify's pino logger emits one object on the way in (req) and one on the
	@# way out (res + responseTime); anything without them is a startup line and
	@# is passed through as-is so errors are not swallowed by the filter.
	$(COMPOSE) logs -f --no-log-prefix api | node $(BACKEND)/scripts/tail-requests.mjs

requests-raw: ## The same log, unfiltered JSON
	$(COMPOSE) logs -f --no-log-prefix api

ps: ## Show what is running
	$(COMPOSE) ps

restart: ## Rebuild and restart api + worker (leaves the datastores alone)
	$(COMPOSE) up -d --build api worker

##@ Quality

test: ## Run the backend test suite (starts its own postgres; no setup needed)
	$(MAKE) -C $(BACKEND) test

check: ## Everything CI runs, both workdirs
	$(MAKE) -C $(BACKEND) ci
	$(MAKE) check-web

lint: ## Check formatting and lint rules in both workdirs (no writes)
	$(MAKE) -C $(BACKEND) lint
	cd $(FRONTEND) && pnpm lint:ci

typecheck: ## Type-check both workdirs
	$(MAKE) -C $(BACKEND) typecheck
	cd $(FRONTEND) && pnpm typecheck

check-web: ## Type-check, lint, build and verify the consoles
	cd $(FRONTEND) && pnpm check

build-web: ## Static-export the consoles to frontend/out
	cd $(FRONTEND) && pnpm build

##@ Utilities

urls: ## Print every browsable endpoint
	@$(MAKE) -C $(BACKEND) urls BASE_URL=$(API_URL) WEB_URL=$(WEB_URL)

smoke: ## Exercise a running engine end to end
	$(MAKE) -C $(BACKEND) smoke BASE_URL=$(API_URL)

clean: ## Remove build output and caches from both workdirs
	$(MAKE) -C $(BACKEND) clean
	rm -rf $(FRONTEND)/.next $(FRONTEND)/out

check-secrets: ## Fail if backend/.env still holds placeholders from the example
	@# Runs BEFORE the images build. Without it the first sign that
	@# CIXTECH_ENGINE_XPRV is still REPLACE_ME is a base58 error from four frames
	@# inside HDKey, two and a half minutes into `make up`. backend/Makefile owns
	@# the placeholder list, so there is one definition of "not filled in yet".
	@$(MAKE) -C $(BACKEND) check-env

reset: ## Clean, drop node_modules, and reinstall both workdirs
	$(MAKE) clean
	rm -rf $(BACKEND)/node_modules $(FRONTEND)/node_modules
	$(MAKE) install
