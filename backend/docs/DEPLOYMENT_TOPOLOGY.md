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
| `external-reconcile` | Ledger vs. chain reconciliation — **off unless `CIXTECH_RECONCILE_CHAIN_BALANCES=true`** | 5m |
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

### External reconciliation is opt-in, and off means off

`external-reconcile` compares every ledger ASSET account against an on-chain
balance and **trips the global kill switch on any difference** (ADR 0010), which
halts every payout until an operator resets it. That is the right answer to real
drift and a catastrophic one to imaginary drift, so it runs only when a real chain
balance source exists — `CIXTECH_RECONCILE_CHAIN_BALANCES=true` plus a chain
router. Otherwise the worker removes the schedule and logs at ERROR that the
ledger is not being checked. It never substitutes a placeholder balance source;
see `docs/SECURITY_AUDIT.md` (CX-26) for what happened when it did.

Note that this reads balances through the same provider the detector uses, which
does not yet satisfy the build spec's §2 independent-source rule — a single wrong
provider would agree with itself. A second provider is outstanding.

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

`output: "export"` in `next.config.mjs`. Every page is behind a human session
(ADR 0018): an httpOnly `cx_session` cookie the page cannot read, plus a CSRF
token held in memory and echoed on every mutation. Every byte of data comes from
a separate cross-origin API, so there is nothing to render on a server — no SEO
surface, and no way to fetch a tenant's data server-side without forwarding their
session to a second machine.

So the output is plain files behind nginx. That keeps the image small, and — more
to the point — keeps a server process that handles credentials out of the
deployment entirely. Nothing in the consoles stores a credential in
`localStorage`; the only thing kept there is the light/dark theme preference.

### Routing

Each of the 18 views is a route now, not a `views[name]()` dispatch. That is not
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
    session-gate.tsx    the sign-in wall + forced password change
    sign-in.tsx         password, then TOTP or a recovery code
    theme-toggle.tsx    light/dark, the one thing kept in localStorage
  lib/
    session.ts          cookie session, CSRF header, login/MFA/logout
    api.ts              thin typed wrappers over session.apiFetch
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

`types/api.d.ts` writes the API contract down on the frontend side of the
boundary. That boundary is real: a running console may be older or newer than the
API it is talking to, so a field has to be added before it is read, and read
before it is removed.

`verify.mjs` runs after `next build` as the package's test, against the exported
`out/`. It checks what a type system cannot: that every one of the 18 routes
actually emitted an HTML document, and that each one loads `/config.js` — without
which the console has no API base and every call goes to the static host.

```bash
cd frontend && docker build -t cixtech-web .
```

---

## The console proxies the API, so there is one origin

The consoles and the API share an origin: the web container serves the static
pages **and** forwards `/v1`, `/auth`, `/admin/api` and `/docs` to the API.

```
browser  ->  web:8080  ->  api:3000
             (nginx)
```

The base compose file does not publish port 3000, so the API has no address the
browser could reach even if the console tried. `docker-compose.dev.yml`
republishes it on `127.0.0.1` for `curl`, `make smoke` and the API reference.

| Setting | Service | Meaning |
| --- | --- | --- |
| `CIXTECH_API_BASE` | web | **Empty** to proxy (default). Set it to go cross-origin. |
| `CIXTECH_API_UPSTREAM` | web | Where nginx forwards; `http://api:3000` by default |
| `CIXTECH_TRUST_PROXY` | api | Whether `X-Forwarded-For` is believed |
| `CIXTECH_CORS_ORIGINS` | api | Only needed cross-origin |

Four properties worth knowing:

* **`CIXTECH_TRUST_PROXY` is the load-bearing one.** Behind the proxy every
  request arrives from nginx, so without it `req.ip` is the proxy for every
  caller — which silently collapses the per-IP limit on failed credentials
  (CX-08) into one bucket and writes nginx into the sign-in log and the admin
  audit trail. It is set to `true` in the base file and `false` in the dev
  overlay, because the overlay republishes port 3000 and anything able to reach
  the API directly could otherwise forge the header.
* **nginx replaces `X-Forwarded-For` rather than appending to it**, so a
  client-supplied value cannot be prepended to the chain and read as the origin.
* **The upstream is resolved per request**, via Docker's embedded DNS rather than
  a literal hostname in `proxy_pass`. With a literal, nginx refuses to start at
  all when the API is not up yet, turning a slow dependency into a crash loop.
* **Cookies are `SameSite=Lax`.** One origin means the cross-site cookie ADR 0018
  settled for is no longer needed, and Lax is strictly stronger. The CSRF
  double-submit token stays regardless.

`pnpm dev` mirrors this: `next.config.mjs` rewrites the same four prefixes in
development, using `beforeFiles` so they win over the App Router, with
`skipTrailingSlashRedirect` so `trailingSlash: true` cannot 308 an API call into
a 404. The console's own code is identical in both modes — always relative URLs.

### Going back to cross-origin

Set `CIXTECH_API_BASE` on the web service to an origin the browser can reach.
nginx then serves 404s on those prefixes instead of proxying, and
`CIXTECH_CORS_ORIGINS` plus `CIXTECH_COOKIE_CROSS_SITE=true` on the api service
have to come back with it. There is no wildcard: `*` is forbidden alongside
credentials and the browser enforces it too.

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
