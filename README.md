# cixtech

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
packages/
  types/         @cixtech/types        branded ids, money, account taxonomy
  ledger/        @cixtech/ledger        pure double-entry core + solvency invariant
  chain-config/  @cixtech/chain-config  per-(chain, env) registry + token registry
tooling/
  no-magic-constants/  CI guard: no chain id / address / rpc literal outside chain-config
```

### Getting started

`make` on its own lists every task. The common path:

```bash
cp .env.example .env    # then fill in your Postgres URLs
make setup              # install dependencies + migrate the database
make dev                # start the engine
make test               # full suite — needs no database of its own
```

`make` wraps the underlying `pnpm`/`turbo` scripts; `pnpm test` and friends still
work if you prefer them directly.

| | |
| --- | --- |
| `make test` | full suite (`make test PKG=ledger` scopes to one package) |
| `make ci` | typecheck + lint + constants guard + tests |
| `make smoke` | end-to-end curl walkthrough against a running engine |
| `make urls` | the browsable endpoints (docs, portal, admin, metrics) |
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
