# cixtech — Deployment Topology

**Status:** current as of 2026-09-08
**Supersedes:** the single-image deployment described in earlier revisions of
`docker-compose.yml`

The engine ships as **three independently deployable services**. Each has its own
Dockerfile, its own release cadence, and its own scaling characteristics. Nothing
couples them at runtime beyond Postgres and Redis, so they can live on different
hosts, different clusters, or (for the frontend) a CDN.

| Service | Workdir | Entry point | Image | Scaling |
| --- | --- | --- | --- | --- |
| **Backend** | `backend/` | `src/api/server.ts` | `Dockerfile.api` | Stateless — scale freely |
| **Workers** | `backend/` | `src/worker/main.ts` | `Dockerfile.worker` | **One replica** |
| **Frontend** | `frontend/` | — | `Dockerfile` | Stateless, or a CDN |

Three deployables, **two workdirs**. The API and the worker build from the same
source tree because they share the ledger, the chain adapters and the pool: the
process that credits a deposit and the process that debits a payout must agree
about double-entry accounting, and the surest guarantee of that is running the
same code. The frontend shares nothing with either, which is why it is separate.

Each workdir installs, builds, tests and containerises with no reference to
anything outside itself, so either can become its own repository unchanged.

```
                    ┌──────────────┐
   browser ────────▶│  web :8080   │  static consoles, no Node, no secrets
                    │   (nginx)    │
                    └──────┬───────┘
                           │ fetch(CIXTECH_API_BASE + path)   ← cross-origin
                           ▼
                    ┌──────────────┐
                    │  api :3000   │  HTTP only. No timers, no singleton work.
                    └──────┬───────┘
                           │
              ┌────────────┴────────────┐
              ▼                         ▼
        ┌───────────┐            ┌────────────┐
        │ postgres  │◀───────────│  worker    │  detection, webhooks,
        └───────────┘            │  :3001     │  reconcile, pool release
              ▲                  └─────┬──────┘
              └────────────────────────┘
                         redis (BullMQ queues)
```

---

## Backend — `backend/`, `Dockerfile.api`

Serves the tenant API (`/v1/*`), the admin control plane (`/admin/api/*`), the
OpenAPI reference (`/docs`), health/readiness, and metrics. It serves **no HTML**.

It is genuinely stateless: it holds no timers and does no singleton work, so
replica count is a free variable. That was not true before — see *Workers* below.

It is also the only service that runs migrations, via its entrypoint. Keeping DDL
in exactly one image is what stops two deployments racing the same schema change.

**Requires:** `DATABASE_URL`, `CIXTECH_ENGINE_XPRV`, `CIXTECH_ADMIN_TOKEN`,
`CIXTECH_POLICY_KEY`, and — on mainnet — the full money-out guardrail set
(see `assertPolicyConfigured` and `docs/SECURITY_AUDIT.md` CX-04).

```bash
cd backend && docker build -f Dockerfile.api -t cixtech-api .
```

## Workers — `backend/`, `Dockerfile.worker`

Everything that runs on a schedule rather than in response to a request:

| Queue | What it does | Default interval |
| --- | --- | --- |
| `deposit-detect` | Polls each chain, credits deposits past finality | 15s |
| `webhook-dispatch` | Drains the outbox, retries, dead-letters | 5s |
| `external-reconcile` | Ledger vs. chain reconciliation | 5m |
| `pool-release` | Returns cooled addresses to AVAILABLE | 60s |
| `pool-balance` | Refreshes the console's balance cache | 2m |

### Deposit detection moved here, and that matters

Detection used to be a `setInterval` inside the API. That quietly made the API
un-scalable: **every replica ran its own poller**, so a second API replica doubled
the RPC load against every chain and had both instances racing to ingest the same
deposits. Ingest is idempotent — the ledger dedupes on `{chain}:{txId}:{index}` —
so it was never a double-credit, but it was wasted upstream quota and lock
contention that grew linearly with replica count.

As a BullMQ repeatable job there is exactly one poller regardless of replica
count, and `concurrency: 1` stops overlapping runs against a slow RPC endpoint
from reintroducing the same racing.

**The consequence: the worker is now REQUIRED.** Without it running, deposits are
never detected and never credited. The API logs this at ERROR when `REDIS_URL` is
absent, and falls back to in-process loops for single-process development only.

**Run one replica.** BullMQ gives one runner per repeatable job, but two worker
processes still both attempt to register the schedules.

**Requires:** the same key material and chain configuration as the API — it
derives the pool addresses it watches. This image is exactly as security-sensitive
as the API image.

```bash
cd backend && docker build -f Dockerfile.worker -t cixtech-worker .
```

## Frontend — `frontend/`

The admin console and tenant portal, as a **Next.js app exported to static
files** and served by nginx. No Node runtime, no database connection, no key
material — ~75 MB against the backend's ~650 MB.

Both consoles were previously inline TypeScript strings served by the API, which
meant the frontend could never ship without redeploying the custody engine.

### Why a static export rather than a Next server

`output: "export"` in `next.config.mjs`. Every page is behind a credential the
browser holds (an admin bearer token or a tenant API key, in `localStorage`) and
every byte of data comes from a separate cross-origin API. There is nothing to
render on a server: no SEO surface, no session cookie to read, and no way to fetch
a tenant's data server-side without forwarding their credential to a second
machine.

So the output is plain files behind nginx. That keeps the image small, and — more
to the point — keeps a server process that handles admin tokens out of the
deployment entirely.

### Routing

Each of the 17 views is a route now, not a `views[name]()` dispatch. That is not
cosmetic: an operator can link a colleague straight to the audit trail during an
incident, and the back button works.

### Layout

```
frontend/
  types/api.d.ts        the API shapes the consoles consume (see note below)
  app/
    layout.tsx          loads /config.js before anything else
    design-system.css   the whole visual system, carried over unchanged
    admin/    layout.tsx + 10 routes
    portal/   layout.tsx + 7 routes
  components/
    primitives.tsx      Table, Panel, Badge, Money, StatGrid, …
    shell.tsx           sidebar, navigation, sign-out
    auth-gate.tsx       the credential wall
  lib/
    api.ts              typed client, credential storage, 401 handling
    money.ts            base-unit arithmetic — never touches `number`
    labels.ts           plain language for ledger keys and entry kinds
    use-api.ts          fetch / loading / error, with stale-response guarding
  public/config.js      window.CIXTECH — overwritten at container start-up
```

The design system CSS carried over **unchanged**. It is the product's visual
identity, it works, and rewriting 30KB of it into another styling system as a side
effect of a framework change would be gratuitous risk. React supplies structure
and state; the look was already settled.

`lib/money.ts` is the piece to read first. The ledger stores integer base units
and the API returns them as strings, so nothing there converts an amount to
`number` — the formatting is pure string arithmetic, and `toBaseUnits` refuses an
amount with more decimal places than the asset has rather than silently
truncating someone's payout.

`types/api.d.ts` is not compiled into the bundle — the consoles are plain browser
JavaScript. It exists so the API contract is written down on the frontend side of
the boundary. That boundary is real now: a running console may be older or newer
than the API it is talking to, so a field has to be added before it is read, and
read before it is removed.

`build.mjs` resolves `/* @inject shared/ui-kit.js */` directives and copies to
`dist/`. It is dependency-free — the consoles are plain ES5-compatible JS and
hand-written CSS, so there is no framework to compile and no reason to make a
static bundle depend on a toolchain that can break it.

`verify.mjs` runs as the package's test and catches what a missing type system
would not: unresolved inject directives, a kit injected twice, a syntax error, a
bare `fetch()` that would hit the static host instead of the API, and a
`config.js` that loads after `app.js`.

```bash
cd frontend && docker build -t cixtech-web .
```

---

## The two settings that must agree

Going cross-origin introduced exactly one coupling, and it is a common source of
"the console loads but every call fails":

| Setting | Service | Meaning |
| --- | --- | --- |
| `CIXTECH_API_BASE` | web | Where the **browser** reaches the API |
| `CIXTECH_CORS_ORIGINS` | api | Comma-separated origins allowed to call the API |

`CIXTECH_API_BASE` must be reachable **from the browser**, not from inside the
container network. `http://api:3000` works between containers and fails in a
browser; that is why compose sets `http://localhost:3000`.

Three properties worth knowing:

* **There is no wildcard.** `*` on an API that accepts a bearer credential in a
  header would let any page on the internet make authenticated calls with a stolen
  key from the victim's own browser. The allowlist is explicit.
* **`credentials` is off.** Both consoles authenticate with a header
  (`x-api-key`, `authorization`), never a cookie, so there is no ambient session
  for a hostile page to ride.
* **Empty means no cross-origin browser access at all** — the correct setting for
  a deployment that fronts the API and the consoles under one hostname via a
  reverse proxy, where `CIXTECH_API_BASE` is also empty.

### Security headers moved with the frontend

The API's `@fastify/helmet` no longer covers the console pages, because the API no
longer serves them. `frontend/nginx.conf` sets the CSP, `frame-ancestors 'none'`,
`nosniff`, `Referrer-Policy` and HSTS itself, and the entrypoint templates
`connect-src` from `CIXTECH_API_BASE` — a CSP that does not name the API origin
blocks every call the consoles make. Forgetting this would silently undo CX-13
from `docs/SECURITY_AUDIT.md`.

---

## Running the stack

```bash
cp backend/.env.example backend/.env   # fill in the secrets — there are no defaults
docker compose up -d --build           # postgres, redis, api, worker, web
```

Individually, for development (from `backend/`):

```bash
make dev          # API      (:3000)
make dev-worker   # worker   (:3001)
make dev-web      # consoles (:8080)
make images       # build all three images
make urls         # print every browsable endpoint
```

`make dev` alone is enough for API work, but **deposits are not credited without
the worker** unless `REDIS_URL` is unset, in which case the API falls back to
in-process loops.

## Shared code

Nothing is duplicated. The API and the worker are two entry points into one
module graph:

```
src/api/server.ts ─┐
                   ├─→ src/{ledger,chains,attribution,chain-config,postgres,errors}
src/worker/main.ts ┘        types/
```

`DepositWatcher` sits in `src/chains/ingest/deposit-watcher.ts` because both the
worker's job and the API's single-process fallback loop use it.

The workspace that used to hold these as `@cixtech/*` packages is gone. Modules
are directories now, reached through the `@/…` alias declared in three places
that must agree — `tsconfig.base.json` (typecheck), `vitest.config.ts` (tests)
and `bundle.mjs` (build). If they ever disagree, a test resolves a different file
than the build ships.

Two things the merge fixed along the way:

* The worker used to declare `start: node dist/main.js` against `tsc` output that had
  never actually run — node's ESM resolver cannot follow the `.js`-importing-`.ts`
  convention, so it failed on its first workspace import. Both entry points now
  bundle through the same esbuild pipeline.
* `src/api` keeps `exactOptionalPropertyTypes: false` (Fastify's generics are not
  compatible with it) via `tsconfig.api.json`, while every other module is still
  checked with it on by `tsconfig.json`. That scoped exemption existed before the
  merge and was preserved rather than flattened into a repo-wide relaxation.
