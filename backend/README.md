# cixtech — backend

Licensed multi-tenant crypto-custody engine (Wallet-as-a-Service). egofi is the
first tenant; the engine is sold to other businesses as infrastructure.

> Governing spec and decisions live with the custodian entity. See
> `CUSTODY_ENGINE_BUILD_SPEC.md` and ADRs 0006–0011.

## Status — Build Step 1: ledger core + config spine ✅ complete

The only step with **zero external dependencies** — no keys, no chains, no
network. It proves the accounting before anything can move money, and ships the
config discipline that keeps the testnet→mainnet switch a config swap.

All 12 ledger properties are green (balance algebra, fee split, reorg reversal,
solvency, and — via `SqlLedgerStore` on a real PostgreSQL server — concurrency,
idempotency, and the internal reconciler), plus the config-registry totality
property and the no-magic-constants CI guard.

```
types/            branded ids, money, account taxonomy — imported as @/types
src/
  api/            HTTP surface: routes, auth, scopes, admin plane   → dist/api.mjs
  worker/         scheduled work: detection, webhooks, reconcile    → dist/worker.mjs
  ledger/         pure double-entry core + solvency invariant
  chains/         chain adapters, payout policy, broadcasters
  attribution/    pooled deposit attribution + gather
  chain-config/   per-(chain, env) registry + token registry
  postgres/       the SqlClient driver adapter
  errors/  signing/  mpc/  ai/
test/             mirrors src/ — test/<module>/ holds that module's tests
  support/        embedded Postgres harness, one schema per test
tooling/
  no-magic-constants/  guard: no chain id / address / rpc literal outside chain-config
```

Modules are directories, imported through the `@/…` alias declared in
`tsconfig.base.json`, `vitest.config.ts` and `bundle.mjs` — the three must agree.
There is no workspace, no per-module `package.json`, and nothing to build before
something else can import it.

### Two deployables from this one tree

| | Entry point | Image | Scaling |
| --- | --- | --- | --- |
| **API** | `src/api/server.ts` | `Dockerfile.api` | stateless — no timers, no singleton work |
| **Worker** | `src/worker/main.ts` | `Dockerfile.worker` | **one replica**; owns deposit detection |

They share every module under `src/` on purpose: the process that CREDITS a
deposit and the process that DEBITS a payout must agree about double-entry
accounting, and the surest guarantee of that is running the same ledger code.

The consoles are a third deployable and live in [`../frontend`](../frontend).
See [docs/DEPLOYMENT_TOPOLOGY.md](docs/DEPLOYMENT_TOPOLOGY.md).

Two things to know before running it:

* **The worker is required.** Deposit detection lives there, not in the API.
  Without it, deposits are never credited.
* **The consoles are cross-origin.** `CIXTECH_API_BASE` (frontend) and
  `CIXTECH_CORS_ORIGINS` (api) must agree, or the console loads and every call
  fails.

### Getting started

`make` on its own lists every task. The common path:

```bash
cp .env.example .env    # then fill in your Postgres URLs and the required secrets
make setup              # install dependencies + migrate the database
make up                 # the whole stack: postgres, redis, api, worker, web
make test               # full suite — brings up its own embedded Postgres
```

`make` wraps the underlying `pnpm`/`turbo` scripts; `pnpm test` and friends still
work if you prefer them directly.

| | |
| --- | --- |
| `make test` | full suite (`make test PKG=ledger` scopes to one package) |
| `make ci` | typecheck + lint + constants guard + tests |
| `make smoke` | end-to-end curl walkthrough against a running engine |
| `make urls` | browsable endpoints across all three services |
| `make up` / `make down` | the whole stack in Docker |
| `make images` | build all three images |
| `make dev` / `dev-worker` / `dev-web` | run one service at a time |
| `make db-migrate` | apply schemas, verify RLS + pooling |
| `make db-role` | provision the engine's least-privileged database role |

### Database (ADR 0013)

Set `DATABASE_URL` in `.env` (see `.env.example`) to run on managed Postgres, then
apply the schema. Migration is a deliberate command — the server verifies the
schema and refuses to boot rather than running DDL against a custody database as a
start-up side effect.

```bash
make db-role      # first time only: provision the engine's DB role
make db-migrate   # apply schemas, verify RLS + pooling
make dev          # start the API
```

`--create-app-role` prints a connection string **once**. Point `DATABASE_URL` at
it and keep the owner credentials as `DIRECT_DATABASE_URL` for future migrations.
The split is load-bearing rather than tidy: the app role is `NOBYPASSRLS`, without
which §13 tenant isolation is silently inert on Neon, and it holds no
`UPDATE`/`DELETE` on `journal_entry`, `posting`, `admin_audit`, or `error_log`, so
ADR 0010's append-only ledger is enforced by the database rather than by
convention.

Postgres is required — there is no embedded fallback, so a misconfigured
deployment fails at boot instead of quietly running on a database that cannot hold
value.

### Tests run on real PostgreSQL

`make test` starts one real PostgreSQL server per package (`embedded-postgres`, a
child process on loopback — no Docker, nothing written outside this repo) and
gives every test its own schema. No `DATABASE_URL`, no setup.

That is not a detail: pool-scoped transactions, savepoint nesting, genuinely
concurrent writers, row-level security, and the append-only grants only exist on a
real server with a real role. Two production bugs were invisible until the suite
moved off an in-process database — see ADR 0013.

### The invariant that gates everything

```
Σ ASSET(pool_addr + treasury + cold + gas_float)
    ≥ Σ LIABILITY(available + pending + pending_withdrawal + compliance_suspense)   (per asset)
```

Enforced continuously; a drift freezes withdrawals. See `packages/ledger`.

**Nothing in later steps may move value until every property in
`packages/ledger/test` is green.**


https://claude.ai/code/artifact/c316634a-4081-4754-8c78-2e58f355ae3d
