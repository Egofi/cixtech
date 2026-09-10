# cixtech

Licensed multi-tenant crypto-custody engine (Wallet-as-a-Service).

Two self-contained workdirs, three deployables. Each workdir installs, builds,
tests and containerises on its own — either can become its own repository unchanged.

| Workdir | What it is | Deployables |
| --- | --- | --- |
| [`backend/`](backend/) | Custody engine — Node, TypeScript, Postgres | HTTP API + background worker |
| [`frontend/`](frontend/) | Admin console + tenant portal — Next.js, static export | console bundle |

---

## Prerequisites

| | Version | Needed by |
| --- | --- | --- |
| Node | ≥ 20 | both |
| pnpm | ≥ 9 | both (`corepack enable`) |
| Docker + Compose | any current | running the stack |
| PostgreSQL | 17 | backend at runtime (Compose provides it) |
| Redis | 7 | worker at runtime (Compose provides it) |

Tests need no database of their own — the backend starts an embedded Postgres.

---

## Everything at once (Docker)

```bash
cp backend/.env.example backend/.env     # fill in the four required secrets below
docker compose up -d --build             # postgres, redis, api, worker, web
```

All configuration lives in `backend/.env` — Compose is pointed at it by the
one-line `.env` at the repo root, which holds `COMPOSE_ENV_FILES` and nothing
else. Do not put secrets in the root `.env`; it is committed.

- Consoles → <http://localhost:8080/portal/> and <http://localhost:8080/admin/>
- API docs → <http://localhost:3000/docs>

```bash
docker compose logs -f api worker        # follow
docker compose down                      # stop, keep volumes
docker compose down -v                   # stop, drop data
```

### Required secrets — in `backend/.env`

| Variable | What it is |
| --- | --- |
| `POSTGRES_PASSWORD` | database password |
| `CIXTECH_ENGINE_XPRV` | master key for every custody address — `cd backend && pnpm generate-test-key` |
| `CIXTECH_ADMIN_TOKEN` | guards the admin plane, `/metrics`, kill switch, fee sweep |
| `CIXTECH_POLICY_KEY` | signs the per-payout authorization token |

A chain registers only if its RPC URL is set, and then **all** its token addresses
are required — a missing one refuses the boot. Confirm them against the networks
before they see value: `cd backend && pnpm verify:chains`.

On `CHAIN_ENV=mainnet` the API additionally refuses to boot without
`CIXTECH_MAX_PAYOUT`, `CIXTECH_VELOCITY_MAX`, `CIXTECH_VELOCITY_WINDOW_MS`,
`CIXTECH_APPROVAL_THRESHOLD`, `CIXTECH_APPROVAL_REQUIRED`,
`CIXTECH_TIMELOCK_THRESHOLD`, `CIXTECH_TIMELOCK_DELAY_MS` and
`CIXTECH_ACKNOWLEDGE_HOT_KEY=true`.

---

## backend/

```bash
cd backend
pnpm install
cp .env.example .env          # set DATABASE_URL + the secrets above
pnpm db:migrate               # apply the schema — the server will not run DDL itself
pnpm dev                      # API      :3000
pnpm dev:worker               # worker   :3001   (needs REDIS_URL)
```

Running `pnpm dev` on the host needs the datastores reachable from the host, and
the base compose file deliberately does not publish them (see CX-18). Bring them
up with the dev overlay, which binds to loopback only and is never loaded unless
you pass `-f`:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d postgres redis
pnpm db:migrate
pnpm dev
```

Redis is published on **6380**, not 6379, because 6379 is often already taken by
another project — and pointing cixtech's queues at someone else's Redis fails
silently rather than loudly. `backend/.env` must match:
`REDIS_URL=redis://127.0.0.1:6380`. Containers are unaffected; compose sets their
`DATABASE_URL` and `REDIS_URL` to the service names.

| Command | |
| --- | --- |
| `pnpm check` | typecheck + lint + constants guard + tests |
| `pnpm test` | full suite (embedded Postgres, no setup) |
| `make test PKG=ledger` | one module's tests |
| `pnpm build` | → `dist/{api,worker,migrate}.mjs` |
| `pnpm verify:chains` | ask each chain to confirm its own config |
| `pnpm db:types` | regenerate `types/ports/db.ts` from `src/schemas/sql` |
| `pnpm rotate-admin-token` | rotate the admin token |
| `make urls` | print every browsable endpoint |

### Where things live

```
backend/src/
  services/      business logic          admin, portal, payout, fee-sweep, ledger
  stores/        database adapters       tenant, auth, pool, approval, policy, ledger
  schemas/sql/   every CREATE TABLE
  schemas/http/  request validation
  common/        errors/  exceptions/  routes/
  chains/        per-chain adapters      tron/ evm/ payout/ ingest/ treasury/
  ledger/        double-entry core + LedgerStore port
  attribution/   deposit pools + PoolStore port
  api/           HTTP wiring, composition roots, migrations
  worker/        BullMQ jobs
backend/types/
  models/        data shapes, one file per domain + branded ids/money
  enums/         AccountType, Scope
  ports/         SqlClient
  errorTypes/    error codes      routeTypes/  route access shapes
```

One rule per kind: `<name>.service.ts`, `<name>.store.ts`, `<name>.schema.ts`.
Route paths are declared only in `common/routes/`, error codes only in
`types/errorTypes/`, and each is checked by a test. Ports (`ledger.port.ts`,
`pool.port.ts`) stay with their domain; their adapters live in `stores/`.
Data shapes live in `types/`; interfaces with methods are contracts and stay
beside the domain that defines them.
See [ADR 0021](backend/docs/adr/0021-repository-layout.md).

```bash
docker build -f Dockerfile.api    -t cixtech-api .
docker build -f Dockerfile.worker -t cixtech-worker .
```

> **The worker is required.** Deposit detection runs there, not in the API —
> without it, deposits are never credited. With `REDIS_URL` unset the API falls
> back to in-process loops for single-process development only; never run that
> with more than one API replica.

---

## frontend/

```bash
cd frontend
pnpm install
pnpm dev                      # consoles :8080, hot reload
```

| Command | |
| --- | --- |
| `pnpm check` | typecheck + lint + build + verify |
| `pnpm build` | static export → `out/` |
| `pnpm start` | serve the built `out/` on :8080 |

```bash
docker build -t cixtech-web .
```

---

## The two settings that must agree

The consoles are a separate origin, so this is the usual cause of "the console
loads but every call fails":

| Variable | Where | Meaning |
| --- | --- | --- |
| `CIXTECH_API_BASE` | frontend | where the **browser** reaches the API |
| `CIXTECH_CORS_ORIGINS` | backend | origins allowed to call the API (no wildcard) |

`CIXTECH_API_BASE` must be reachable from the browser — `http://api:3000` works
between containers and fails in a browser. Leave both empty when a reverse proxy
fronts the API and the consoles under one hostname.

---

## Docs

In [`backend/docs/`](backend/docs/): [`DEPLOYMENT_TOPOLOGY.md`](backend/docs/DEPLOYMENT_TOPOLOGY.md)
(what each service owns), [`SECURITY_AUDIT.md`](backend/docs/SECURITY_AUDIT.md)
(findings, fixes, what is outstanding),
[`CUSTODY_ENGINE_BUILD_SPEC.md`](backend/docs/CUSTODY_ENGINE_BUILD_SPEC.md) and
[`adr/`](backend/docs/adr/).
