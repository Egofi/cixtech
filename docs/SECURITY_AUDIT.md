# cixtech — Security Audit

**Scope:** cixtech custody engine — HTTP surface, money-out path, chain adapters, shipped deployment
**Revision:** branch `engine-realignment` @ `97646de`
**Date:** 2026-09-08
**Method:** static review plus executed proofs-of-concept against a locally built engine on an
ephemeral Postgres schema. No production system, tenant data or live chain was touched.

Twenty-four findings. **Three are critical** and each one, on its own, hands an attacker every key
the engine controls. Eleven were reproduced against a live build (marked **proven**, with the test
output quoted); the rest are confirmed by reading the wiring.

| Severity | Count |
| --- | --- |
| Critical | 3 |
| High | 6 |
| Medium | 9 |
| Low | 6 |

---

## The short version

Three things to understand before the finding list.

**1 — The shipped compose file publishes the wallet.** `docker-compose.yml` carries a working
extended private key as the default for `CIXTECH_ENGINE_XPRV`, next to `NODE_ENV: production`. It is
not a placeholder — it derives real keys. Every deposit and pool address the engine mints from it is
controlled by anyone who has read this repository.

**2 — Every guardrail on the money-out path is optional.** The per-payout authorization token, dual
approval and the time-lock each activate only when their environment variable happens to be set; the
sanctions screener and the deposit KYT screener are never wired at all. The *tables* for row-level
security are created, forced and asserted at boot — but no request path ever binds the tenant GUC, so
RLS filters nothing at runtime. Controls documented as boundaries are, in the shipped configuration,
absent.

**3 — Tron signs whatever the RPC node hands back.** The EVM broadcaster builds and RLP-encodes the
transaction locally and refuses a hash the node disagrees with. The Tron broadcaster asks the node to
build the transaction, then signs the `txID` the node returned without ever checking what is inside
it. The correct pattern already exists in this codebase, one directory over.

---

## Findings index

| ID | Finding | Severity | Zone | Status |
| --- | --- | --- | --- | --- |
| [CX-01](#cx-01--a-live-master-private-key-ships-as-the-compose-default) | Live master private key committed as a compose default | Critical | deploy | proven |
| [CX-02](#cx-02--the-super-admin-token-defaults-to-a-published-string) | Default super-admin token in the same file | Critical | deploy | confirmed |
| [CX-03](#cx-03--the-tron-broadcaster-signs-whatever-the-rpc-node-hands-back) | Tron broadcaster blind-signs the node's transaction | Critical | chains/tron | proven |
| [CX-04](#cx-04--every-money-out-control-fails-open-when-its-variable-is-unset) | Money-out controls fail open when unconfigured | High | bootstrap | confirmed |
| [CX-05](#cx-05--fee-sweep-and-gas-station-move-funds-outside-the-policy-engine) | Fee sweep and gas station bypass policy and authorization | High | admin | confirmed |
| [CX-06](#cx-06--row-level-security-is-installed-asserted-and-never-engaged) | Row-level security is never engaged at runtime | High | api/rls | proven |
| [CX-07](#cx-07--the-ai-routes-authenticate-but-never-check-scope) | AI routes bypass the API-key scope model | High | api/ai | proven |
| [CX-08](#cx-08--nothing-rate-limits-a-credential-guess-on-either-plane) | No rate limiting on any credential | High | api | proven |
| [CX-09](#cx-09--any-tenant-can-point-the-engines-webhook-sender-at-internal-hosts) | Server-side request forgery through the webhook URL | High | api/webhooks | proven |
| [CX-10](#cx-10--every-key-is-issued-with-every-scope-so-scopes-separate-nothing) | Every issued key carries every scope | Medium | api/auth | proven |
| [CX-11](#cx-11--the-ai-ledger-query-carries-no-tenant-predicate--and-has-never-run) | AI ledger query is unscoped by tenant, and broken | Medium | packages/ai | proven |
| [CX-12](#cx-12--anonymous-requests-write-unbounded-rows-to-an-append-only-table) | Anonymous requests fill an append-only audit table | Medium | api/errors | proven |
| [CX-13](#cx-13--no-security-headers-and-both-consoles-keep-credentials-in-localstorage) | No security headers; consoles hold tokens in localStorage | Medium | api/ui | confirmed |
| [CX-14](#cx-14--metrics-and-interactive-docs-are-public) | Metrics and API docs are unauthenticated | Medium | api | proven |
| [CX-15](#cx-15--twenty-advisories-one-of-them-squarely-on-the-ssrf-path) | Twenty dependency advisories, one on the SSRF path | Medium | deps | proven |
| [CX-16](#cx-16--the-mpc-package-is-real-and-production-does-not-use-it) | MPC exists but production runs a single hot key | Medium | signing | confirmed |
| [CX-17](#cx-17--an-allow-listed-destination-can-never-be-removed) | A payout destination can be added but never removed | Medium | payouts | confirmed |
| [CX-18](#cx-18--container-runs-as-root-postgres-is-published-with-a-default-password) | Container runs as root; database exposed with default password | Medium | deploy | confirmed |
| [CX-19](#cx-19--the-transfer-commitment-joins-caller-controlled-fields-with-a-space) | Transfer commitment joins caller-controlled fields with a space | Low | payouts | confirmed |
| [CX-20](#cx-20--rule-and-anomaly-identifiers-come-from-mathrandom) | Identifiers minted from `Math.random()` | Low | packages/ai | confirmed |
| [CX-21](#cx-21--an-unvalidated-rule-threshold-crashes-the-evaluator) | Unvalidated rule threshold crashes the evaluator | Low | packages/ai | confirmed |
| [CX-22](#cx-22--the-zero-day-drain-detector-measures-the-wrong-window) | Anomaly detector measures the wrong window | Low | packages/ai | confirmed |
| [CX-23](#cx-23--destination-addresses-are-validated-only-at-the-last-mile) | Destinations validated only at the last mile | Low | payouts | confirmed |
| [CX-24](#cx-24--the-html-escaper-leaves-single-quotes-intact) | HTML escaper leaves single quotes intact | Low | api/ui | confirmed |

---

## Critical

Each of these alone results in total loss of custody.

### CX-01 — A live master private key ships as the compose default

**Severity:** Critical · **Status:** proven
**Location:** `docker-compose.yml:58`, `docker-compose.yml:43`

`CIXTECH_ENGINE_XPRV` defaults to a literal `xprv…` string. This is the single HD key that
`buildRouter` hands to the signer for every registered chain — Tron and the whole EVM family share
it. The same service block sets `NODE_ENV: production`, so nothing about running it reads as a
development shortcut. Any operator who follows the repository's own `docker compose up` path without
overriding the variable runs a custody engine whose master key is published in git.

Loading the committed string confirms it is not a placeholder:

```
$ node -e "HDKey.fromExtendedKey(<committed xprv>)"
valid xprv, has private key: true
xpub:              xpub6BwBavvzkY29HhDX6MmatRYhrZRu2EocvBznQaETNwnVe…
child 0/0 pubkey:  027a85f8d54598656a535e79d6ef8e5f638415f5546d05f5b34f61ab8aa3ed0401
```

Path `0/index` is exactly what `KeypairSigner.child()` derives for pool addresses.

**Fix.** Treat the key as burned: rotate to a freshly generated xprv, sweep any address ever derived
from the committed one, and purge it from history. Then remove every `:-default` fallback for secret
variables in compose so a missing value fails the boot instead of substituting a known one — the same
posture `buildRouter` already takes when `CIXTECH_ENGINE_XPRV` is absent entirely.

### CX-02 — The super-admin token defaults to a published string

**Severity:** Critical · **Status:** confirmed
**Location:** `docker-compose.yml:59`, `apps/api/src/admin/admin-routes.ts:42`

`CIXTECH_ADMIN_TOKEN` falls back to `dev-admin-token-secret`. That bearer token is the only thing
standing in front of `/admin/api/*`: cross-tenant reads of every ledger account and deposit, the
global kill switch, tenant creation, key issuance and rotation, and `POST /admin/api/earnings/sweep`,
which moves real funds on chain.

The admin plane is otherwise well built — it fails closed when the token is unset, the comparison is
constant-time, and both successful and failed mutations are audited. A published default undoes all
of it.

**Fix.** Drop the fallback. `registerAdmin` already disables the entire plane when the token is
`undefined`, so an unset variable is the correct safe state — let it happen.

### CX-03 — The Tron broadcaster signs whatever the RPC node hands back

**Severity:** Critical · **Status:** proven
**Location:** `packages/chains/src/payout/tron-broadcaster.ts:51-52`

`buildTrc20()` and `buildNative()` ask the configured Tron endpoint to construct the unsigned
transaction. `send()` then takes the `txID` from that response, signs those 32 bytes with the pool
address's key, and broadcasts. It never recomputes the hash from `raw_data`, and never inspects
`raw_data` to confirm the contract is a transfer of the intended amount to the intended destination.

A malicious or compromised endpoint — the compose default points at a third-party public node —
returns any transaction it likes with a self-consistent `txID`, and the engine signs it. A hostile
`HttpClient` was wired in and the broadcaster asked to send 1 USDT to a merchant:

```
engine intended  →  TTetbYe8bRMfz6ASefJACCb2gSzwbe9AqW   amount 1000000
actually SIGNED  →  a9059cbb…dead00000000000000000000000000000000beef…e8d4a50fff
                    recipient word : 000000000000000000000000dead…beef
                    amount word    : 999999999999
                    signature      : 5a75c3d6484afac8e2536f0d…
broadcast accepted  txId 03d539189586efbe6fad8dd81d921579aa62127b13c25ed1…
```

The engine produced a valid signature over a transfer it never authorized.

`AuthorizingBroadcaster` does not help here. It recomputes `transferCommitment` from the same
`PayoutRequest` it is about to forward, so it verifies the request against itself — it says nothing
about the bytes actually signed. The `sighash` claim is described as "the exact 32-byte hash the
signer will sign," but on Tron it is a hash of the intent parameters, not of the transaction.

**Fix.** Mirror `EvmPayoutBroadcaster`, which already does this correctly: it builds the transaction
locally, derives the hash itself, and throws on `Broadcast hash mismatch` if the node disagrees. For
Tron, at minimum verify `txID === sha256(raw_data_hex)` and decode `raw_data` to assert the owner,
contract, recipient and amount before signing. Building the protobuf locally is the stronger answer
and makes the `sighash` claim true.

---

## High

Controls that are documented as boundaries but do not hold as shipped.

### CX-04 — Every money-out control fails open when its variable is unset

**Severity:** High · **Status:** confirmed
**Location:** `apps/api/src/server.ts:145-175`, `apps/api/src/engine.ts:136-139`

The bootstrap composes the policy engine from optional environment variables, and each absent one
silently removes a control rather than refusing to boot:

| Control | Behaviour when unset |
| --- | --- |
| Authorization token | `CIXTECH_POLICY_KEY` unset → no `AuthorizingBroadcaster` at all |
| Dual approval | `CIXTECH_APPROVAL_*` unset → no approval ever required |
| Time-lock | `CIXTECH_TIMELOCK_*` unset → no cancel window |
| Sanctions screen | never constructed in `server.ts` |
| Deposit KYT | `depositScreener` never passed to `buildEngine` |
| Fee treasury | absent per chain → fee stays accrued (safe) |

The shipped `docker-compose.yml` sets none of the first three. A deployment that follows it has no
authorization binding, no dual control, no time-lock, no sanctions screening on the way out and no
KYT on the way in — while the API documentation tells tenants that "completing one always takes two
distinct keys."

**Fix.** Invert the default. Require these at boot when `CHAIN_ENV=mainnet` (or
`NODE_ENV=production`) and fail startup with the same clarity `resolveTokenContracts` already uses
for a missing token contract — that function is the model: it refuses to register a chain rather than
let a silent zero through.

### CX-05 — Fee sweep and gas station move funds outside the policy engine

**Severity:** High · **Status:** confirmed
**Location:** `apps/api/src/admin/admin-service.ts:438`, `apps/api/src/server.ts:87`,
`apps/api/src/engine.ts:137-141`

`buildEngine` wraps the router's broadcaster in `AuthorizingBroadcaster` and hands the wrapped one to
`PayoutService` only. `engine.chains.broadcaster` stays unwrapped — and that is what
`AdminService.sweepFees()` and `BroadcasterGasFunder` both use.

So an admin-triggered fee sweep sends a real on-chain transfer with no per-payout ceiling, no
allow-list check, no velocity budget, no solvency gate and no authorization token. It keeps the kill
switch and the gather lease, which is why this is high rather than critical, but the control-plane
path to moving value is materially weaker than the tenant path — the opposite of what ADR 0015's
"controls are limited to operations that cannot move value outside MPC + policy" claims.

**Fix.** Expose the authorized broadcaster on the `Engine` interface and route every value-moving
caller through it. Give the sweep and the gas top-up their own policy contexts rather than no policy
at all.

### CX-06 — Row-level security is installed, asserted, and never engaged

**Severity:** High · **Status:** proven
**Location:** `apps/api/src/rls.ts:146`, `apps/api/src/app.ts:236`

`rls.ts` is the most carefully reasoned file in the repository. It enables and `FORCE`s policies on
fourteen tenant tables, fails startup if a tenant-scoped table has no policy, and separately checks
that the connecting role is not `BYPASSRLS`. The policy admits everything when the `cixtech.tenant`
GUC is unset, which is correct for the admin plane.

`withTenant()` — the only thing that binds that GUC — is called from `migrate.ts` and from tests. It
appears nowhere in any request path. Every `/v1` handler queries outside a tenant transaction, so the
GUC is null and the first clause of every policy matches:

```
// during a normal authenticated /v1 request
SELECT current_setting('cixtech.tenant', true)  →  null
GET /v1/balances                                →  200
```

Tenant isolation therefore rests entirely on hand-written `WHERE tenant = $1` clauses. That is
exactly the assumption RLS was built to stop depending on — and CX-11 is a query that already forgot
the clause.

**Fix.** Bind the GUC in the `onRequest` hook for authenticated `/v1` traffic, or run tenant handlers
inside `withTenant`. Add a test that asserts a handler cannot read a second tenant's row even with
the predicate deliberately removed — the property is worthless until something proves it is live.

### CX-07 — The AI routes authenticate but never check scope

**Severity:** High · **Status:** proven
**Location:** `apps/api/src/ai/ai-routes.ts:29-37`

Every `/v1` route in `app.ts` goes through `tenantOf(req, scope)`, which asserts the key carries the
scope the route needs. `registerAi` defines its own `tenantOf` that resolves the tenant and returns
it — with no scope argument and no check. All four AI routes, including two mutations, are reachable
by any valid key.

```
// key issued with scopes: ["read"]
POST /v1/accounts   (needs move-funds)             →  403  ✓ correct
POST /v1/ai/rules   (action: PAUSE_WITHDRAWALS)    →  201  ✗
```

A read-only credential can register autonomous rules whose actions include `PAUSE_WITHDRAWALS` and
`REQUIRE_APPROVAL`. Those actions are currently only reported by `evaluateRules` rather than
enforced, which caps today's impact — but the routes are shipped as the enforcement surface, so the
gap closes the wrong way as the feature lands.

**Fix.** Delete the local `tenantOf` and the private `WeakMap`. Register the AI routes on the same
authenticated instance and require `read` for the two GETs and `move-funds` for `POST /v1/ai/rules`.

### CX-08 — Nothing rate-limits a credential guess, on either plane

**Severity:** High · **Status:** proven
**Location:** `apps/api/package.json` — no `@fastify/rate-limit`

There is no rate limiting, no lockout and no backoff anywhere in the stack. Two hundred wrong API
keys and two hundred wrong admin tokens each returned a clean, fast `401`:

```
200 × GET /v1/balances        with x-api-key: cxk_guess_N
   distinct status codes → [ 401 ]   (never 429)

200 × GET /admin/api/overview with Bearer guess-N
   distinct status codes → [ 401 ]   (never 429)
```

Both secrets are high-entropy, so this is not a realistic brute force on its own. It matters because
it removes the ceiling from everything else: unlimited payout attempts against the velocity limiter,
unlimited webhook-URL probes for CX-09, and the unbounded audit writes in CX-12.

**Fix.** Add `@fastify/rate-limit` with a strict global bucket, a much tighter per-IP bucket on
authentication failures, and a separate per-tenant bucket on `POST …/withdrawals`.

### CX-09 — Any tenant can point the engine's webhook sender at internal hosts

**Severity:** High · **Status:** proven
**Location:** `apps/api/src/schemas.ts:437`, `packages/chains/src/webhooks.ts:14-23`

`PUT /v1/webhook` validates the URL with JSON Schema `format: "uri"` and nothing else.
`FetchWebhookPoster` then `fetch`es it from inside the engine's network on a timer, following
redirects, with a signed JSON body:

```
PUT /v1/webhook  http://169.254.169.254/latest/meta-data/  →  201
PUT /v1/webhook  http://127.0.0.1:5432/                    →  201
PUT /v1/webhook  http://localhost:6379/                    →  201
PUT /v1/webhook  http://[::1]:9200/                        →  201
```

It is not fully blind. `recordFailure` stores the connection error, and `GET /v1/webhook/deliveries`
returns it to the tenant as `lastError` — which distinguishes a refused port from an open one, so the
internal network can be mapped from outside. On a cloud host the metadata endpoint is directly
reachable.

**Fix.** Validate on `set`, not on send: require `https`, resolve the hostname and reject loopback,
link-local, and RFC 1918 addresses, then re-check after DNS resolution at send time to close the
rebinding window. Disable redirect following, and coarsen `lastError` to a category before returning
it to the tenant.

---

## Medium

### CX-10 — Every key is issued with every scope, so scopes separate nothing

**Severity:** Medium · **Status:** proven
**Location:** `apps/api/src/stores.ts:43`, `apps/api/src/stores.ts:89`,
`apps/api/src/admin/admin-service.ts:696-703`

`createTenant` and `issueKey` both default `scopes` to the full `SCOPES` tuple, and neither admin
route passes anything else. There is no API path — tenant or admin — that mints a restricted
credential:

```
key1 scopes: [ 'read', 'move-funds', 'approve' ]   keyId 1419eea4
key2 scopes: [ 'read', 'move-funds', 'approve' ]   keyId bc0a3beb
```

The mechanism underneath is sound: `payout_approval` is keyed on `(intent_key, approver)` so repeats
collapse, and `ApprovalStore.approve` rejects the requester. But the documented boundary — "`approve`
does not imply `move-funds`" — cannot be configured. Dual control degrades to two fully-privileged
keys sitting in the same vault.

**Fix.** Accept and validate a `scopes` array on `POST /admin/api/tenants` and `…/keys`, and make the
approver-key scope `["approve"]` the documented default for the second credential.

### CX-11 — The AI ledger query carries no tenant predicate — and has never run

**Severity:** Medium · **Status:** proven
**Location:** `packages/ai/src/financial-ai-engine.ts:87`

Any prompt that misses the keyword branches falls through to a query with no `WHERE` clause at all,
while the answer text tells the caller these are entries "for your tenant". It also selects a column
that does not exist — `journal_entry` has `occurred_at`, not `created_at` — so the branch has
evidently never executed:

```
POST /v1/ai/query  {"prompt": "show me recent transactions"}
  →  500 {"error":{"code":"INTERNAL","message":"Internal error"}}
  error_log: column "created_at" does not exist

// the same query with the column corrected:
SELECT id, occurred_at FROM journal_entry LIMIT 10
  →  [ 'victim-entry-0001' ]   ← another tenant's row
```

Fixing the column name without adding the predicate turns a dead branch into a cross-tenant leak —
and CX-06 means RLS will not catch it. The keyword branches also echo an interpolated `generatedSql`
string back to the caller and hardcode `isSolvent: true` for any solvency prompt, regardless of the
ledger.

**Fix.** Add the tenant predicate and correct the column together, drop the fabricated solvency
answer in favour of `LedgerService.isSolvent`, and stop returning a hand-built SQL string that does
not match the parameterized query actually executed.

### CX-12 — Anonymous requests write unbounded rows to an append-only table

**Severity:** Medium · **Status:** proven
**Location:** `apps/api/src/app.ts:259`, `apps/api/src/app-role.ts:24`

The error handler calls `captureError` for every error, including authentication failures, before the
reply is sent. One unauthenticated request equals one row in `error_log` — a table the application
role is deliberately denied `UPDATE` and `DELETE` on, so nothing in the running system can trim it:

```
100 × GET /v1/balances        with a bad key    error_log:  0 → 100
100 × GET /admin/api/overview with a bad token  error_log:  0 → 100
```

With no rate limit (CX-08) an anonymous caller can grow the audit trail without bound, and bury
genuine incidents under noise on the way.

**Fix.** Don't persist `UNAUTHORIZED` and `VALIDATION` to the durable sink — counting them in the
metrics registry preserves the signal without the storage. Add a retention job that runs as the
migration role.

### CX-13 — No security headers, and both consoles keep credentials in localStorage

**Severity:** Medium · **Status:** confirmed
**Location:** `apps/api/src/app.ts` (no `@fastify/helmet`), `apps/api/src/admin/ui.ts:51`,
`apps/api/src/portal/ui.ts:56`

Neither `helmet` nor a manual header hook is registered, so responses carry no
`Content-Security-Policy`, `X-Frame-Options`, `Strict-Transport-Security` or
`X-Content-Type-Options`. Both consoles are served from the same origin as the API and store their
bearer credential in `localStorage` — the super-admin token in one, a tenant `cxk_` key in the other.
Any script execution on that origin reads both, and the missing frame headers leave the kill-switch
and sweep controls clickjackable.

**Fix.** Register `@fastify/helmet` with a CSP tight enough for the inline consoles (they are inline
strings, so a nonce is straightforward), and add `frame-ancestors 'none'`. Prefer a
`Secure; HttpOnly; SameSite=Strict` session cookie over `localStorage` for the admin console
specifically.

### CX-14 — Metrics and interactive docs are public

**Severity:** Medium · **Status:** proven
**Location:** `apps/api/src/app.ts:78-85`, `apps/api/src/metrics.ts:33`

`isPublic()` exempts `/metrics` and `/docs` from authentication. `collectDefaultMetrics` publishes
the runtime version, process start time, heap and event-loop detail, and the request counters expose
every route pattern with per-status volumes — enough to profile tenant activity and time an incident
from outside:

```
GET /metrics  →  200
nodejs_version_info{version="v24.19.0",major="24",minor="19",patch="0"}
http_requests_total{method="POST",route="/v1/accounts/:id/withdrawals",status="200"}
```

**Fix.** Bind `/metrics` to an internal interface or require the admin bearer token. Keep `/docs`
public if that is intentional — it exposes no data — but decide it rather than inherit it.

### CX-15 — Twenty advisories, one of them squarely on the SSRF path

**Severity:** Medium · **Status:** proven
**Location:** `pnpm-lock.yaml` — `pnpm audit`

```
1 critical · 13 high · 6 moderate

CRITICAL  vitest      <3.2.6          UI server reads and executes arbitrary files
HIGH      fast-uri    <3.1.6 / <4.1.3 SSRF via malformed IPv6 normalization
HIGH      fast-uri    <3.1.6 / <4.1.3 host confusion via percent-decoding
HIGH      find-my-way <=9.6.0         DoS over HTTP/2
HIGH      nanoid      <3.3.18         infinite loop on zero size
MODERATE  fastify     <5.12.1         schema validation bypass via root coercion
MODERATE  fastify     >=5.8.3 <5.12.1 X-Forwarded-* spoofing under trustProxy
```

The `fast-uri` entries are not incidental — that library backs the `format: "uri"` check this
codebase relies on as the only validation of the webhook URL in CX-09. The fastify advisories affect
the JSON-Schema layer the whole API depends on for input validation.

**Fix.** Bump `fastify` to `>=5.12.1` (which pulls the patched `fast-uri` and `find-my-way`) and
`vitest` to `>=3.2.6`. Add `pnpm audit` to CI as a blocking step.

### CX-16 — The MPC package is real, and production does not use it

**Severity:** Medium · **Status:** confirmed
**Location:** `packages/chains/src/build-router.ts:110-113`, `packages/mpc/`

`packages/mpc` implements Shamir splitting, a Feldman-verified dealerless DKG and proactive refresh,
and its own documentation is admirably honest that the signing path reconstructs the key in the
coordinator and that `dealerlessDkg` models all participants in one process. None of it is reachable
from the running engine: `buildRouter` constructs a `KeypairSigner` from `CIXTECH_ENGINE_XPRV` and
shares it across every chain.

So the deployed custody model is one hot HD key held in an environment variable in the API process —
the same process that terminates public HTTP. Any RCE, any memory disclosure, any
`/proc/self/environ` read is total loss. This is disclosed in ADR 0007 as the launch path, so it is a
scope question rather than a defect; it is listed here because the API description and the ADRs read,
to an operator, as though threshold signing is in place.

**Fix.** Near term, move the key behind a KMS or HSM so the API process signs rather than holds, and
make the marketing surface match the deployed model. The `Signer` port is already the right seam for
both.

### CX-17 — An allow-listed destination can never be removed

**Severity:** Medium · **Status:** confirmed
**Location:** `apps/api/src/app.ts:437`, `packages/chains/src/payout/policy-store.ts:166-182`

There is `POST …/allowlist` and `GET /v1/allowlist`, and no delete on either the tenant API or the
admin plane. The cool-down is well designed — it defeats add-and-drain in a single session — but it
is one-directional. A tenant who discovers a destination is compromised has no way to withdraw it,
and after the cool-down elapses it is permanently usable.

Related: `add` uses `ON CONFLICT DO NOTHING` while the route returns a freshly computed `usableAt`,
so re-adding an existing address reports a cool-down that is not in effect. Harmless in itself,
misleading in an incident.

**Fix.** Add `DELETE /v1/accounts/:id/allowlist/:chain/:address`, and return the stored `usable_at`
from `add` via `RETURNING` rather than the value the caller just computed.

### CX-18 — Container runs as root; Postgres is published with a default password

**Severity:** Medium · **Status:** confirmed
**Location:** `Dockerfile`, `docker-compose.yml:10-14, 51`

The image never drops privileges — no `USER` directive, so the engine and its signing key run as uid
0. Dev dependencies and the full source tree ship in the runtime image, and the production `CMD` is
`dev-run.mjs`. The Postgres service publishes `5432` to the host with `POSTGRES_PASSWORD` defaulting
to `cixtech_owner_secret`, and `CIXTECH_DB_SSL: disable` puts the custody database on an unencrypted
connection.

**Fix.** Add a non-root `USER`, split a runtime stage that carries only production dependencies and
built output, run the compiled server rather than the dev runner, drop the published database port,
and remove the password default alongside the others in CX-01.

---

## Low

Correctness and hygiene issues that weaken a control without breaking it.

### CX-19 — The transfer commitment joins caller-controlled fields with a space

**Severity:** Low · **Status:** confirmed
**Location:** `packages/chains/src/payout/authorization.ts:60`

`transferCommitment` hashes `[intentId, chain, asset, amount, destination, fromAddress].join(" ")`.
The separator can appear inside a field: `intentId` is `` `${tenant}:${idempotencyKey}` ``, and the
schema permits any string up to 255 characters as the idempotency key — spaces included. Two
different transfers can therefore canonicalize to the same string. The surrounding constraints make
this hard to weaponize today, but a commitment whose safety depends on other validation is not a
commitment.

**Fix.** Use the length-prefixed or JSON canonicalization already used for the claims in
`canonical()`, a few lines below.

### CX-20 — Rule and anomaly identifiers come from `Math.random()`

**Severity:** Low · **Status:** confirmed
**Location:** `apps/api/src/ai/ai-routes.ts:156`, `packages/ai/src/anomaly-detector.ts:45`

Both mint ids as `Math.random().toString(36).substring(2, 11)` — roughly 46 bits from a
non-cryptographic PRNG. The rule id is a primary key, so collisions surface as insert failures, and
the ids are guessable by anyone who can observe a few. Everything else in the codebase correctly uses
`randomUUID()` or `randomBytes`.

**Fix.** Use `randomUUID()`, as the rest of the repository does.

### CX-21 — An unvalidated rule threshold crashes the evaluator

**Severity:** Low · **Status:** confirmed
**Location:** `apps/api/src/ai/ai-routes.ts:70`, `packages/ai/src/agentic-rules-engine.ts:61`

`conditionThreshold` is accepted as any string, then passed to `BigInt()` at evaluation time. A
non-numeric value is stored happily and throws a `SyntaxError` on every subsequent
`GET /v1/ai/rules` — a self-inflicted, persistent 500 for that tenant.

**Fix.** Apply the same `pattern: "^[1-9][0-9]*$"` the withdrawal schema already uses for base-unit
amounts.

### CX-22 — The zero-day drain detector measures the wrong window

**Severity:** Low · **Status:** confirmed
**Location:** `packages/ai/src/anomaly-detector.ts:33-35`

The query filters `usable_at > now() - interval '24 hours'` and the alert text says "added in last
24h". But `usable_at` is set *forward* by the cool-down (24 hours by default), so the predicate
actually matches everything added in the last 48 hours — and would match every row at all if the
cool-down were raised. The column that means "added" is `added_at`, and it is sitting right there in
the same table.

**Fix.** Filter on `added_at`.

### CX-23 — Destination addresses are validated only at the last mile

**Severity:** Low · **Status:** confirmed
**Location:** `apps/api/src/schemas.ts:415`, `packages/chains/src/payout/policy-store.ts:166`

Both the allow-list and the withdrawal schema check only `minLength: 25, maxLength: 64`. No
chain-specific format or checksum check happens until the broadcaster encodes the transfer, where
`decodeTronAddress` and `normalizeHexAddress` both throw — so this fails safe rather than burning
funds. It fails *late*, though: by then the payout has taken the gather lease and locked funds in the
ledger, and a Tron address allow-listed under an EVM chain is accepted at the API and only rejected
mid-payout.

**Fix.** Validate the address against the chain's encoder at allow-list time and again at withdrawal
request time, before the lease is taken.

### CX-24 — The HTML escaper leaves single quotes intact

**Severity:** Low · **Status:** confirmed
**Location:** `apps/api/src/admin/ui.ts:47`, `apps/api/src/portal/ui.ts:52`

`esc()` handles `& < > "` but not `'`. Every current call site happens to use double-quoted
attributes, so nothing is exploitable today — the rendering paths for tenant-controlled strings were
checked and are consistently escaped. It is one single-quoted attribute away from stored XSS in a
console that holds the super-admin token in `localStorage`, which makes it worth closing now rather
than later.

**Fix.** Add `.replace(/'/g, "&#39;")` to both copies, or build DOM nodes with `textContent` instead
of concatenating HTML.

---

## Suggested order of work

Sequenced by what unblocks the next thing, not strictly by severity.

1. Rotate the exposed xprv and admin token, sweep every address derived from the old key, and purge
   both from git history. Nothing else matters until this is done. — **CX-01, CX-02**
2. Remove every `:-default` for a secret in `docker-compose.yml` and let a missing value fail the
   boot. — **CX-01, CX-02, CX-18**
3. Verify the Tron transaction before signing it — hash check first, `raw_data` decode second. —
   **CX-03**
4. Make the policy, authorization, approval and time-lock configuration mandatory on mainnet, and
   refuse to start without it. — **CX-04**
5. Route the fee sweep and the gas station through the authorized broadcaster. — **CX-05**
6. Bind the tenant GUC on authenticated requests so the RLS work already done starts holding. —
   **CX-06**
7. Put the AI routes behind the scope check and add the missing tenant predicate. — **CX-07, CX-11**
8. Add rate limiting and security headers; stop persisting auth failures to the audit trail. —
   **CX-08, CX-12, CX-13**
9. Validate webhook URLs at set time and bump the dependency set. — **CX-09, CX-15**
10. Work the medium and low list; each is small and self-contained.

---

## What held up well

The parts of this codebase that are right are right for good reasons, and it is worth being specific
about them so a remediation pass does not disturb them.

**SQL is parameterized throughout.** The only interpolated fragments are `LIMIT`/`OFFSET` values
already through `Math.trunc` and `clampLimit`, and identifiers in `app-role.ts` that pass a strict
role-name regex and a quoting helper. No injection was found.

**API keys are stored as SHA-256 hashes and returned once**, revocation is indistinguishable from a
wrong key by design, and `rotateKeys` issues-then-revokes inside one transaction so neither a lockout
nor a surviving leaked key can result from a crash between the steps.

**The EVM broadcaster is the model the Tron one should follow** — local build, local hash, explicit
mismatch check. **The payout intent journal** makes a retry resume rather than re-broadcast, and
**the gather lease** correctly serializes everything spending one merchant's pool addresses,
including the admin console.

**The append-only grants in `app-role.ts`** are a genuinely good control: the application role cannot
`UPDATE` or `DELETE` the ledger or audit trails at all, so a compromised API process cannot rewrite
history. And **`rls.ts`** reasons correctly about `FORCE ROW LEVEL SECURITY` and `rolbypassrls` — two
things most implementations get wrong. It only needs to be switched on.


---

## Remediation status

All twenty-four findings have been addressed in code. `pnpm test` (118 API + 135
chains + the rest), `pnpm typecheck`, `pnpm lint` and `pnpm audit` are green;
`pnpm audit` reports **no known vulnerabilities**, down from 1 critical / 13 high /
6 moderate.

Regression tests live in `apps/api/test/security-controls.test.ts`,
`apps/api/test/tenant-scope.test.ts` and
`packages/chains/test/tron-tx-verify.test.ts`, each named for the finding it pins
down.

| ID | What changed |
| --- | --- |
| CX-01 | `docker-compose.yml` secrets use `${VAR:?message}` — a missing value fails the boot instead of substituting a published default. **The committed xprv must still be rotated and purged from history: see "Still yours to do" below.** |
| CX-02 | Same; `CIXTECH_ADMIN_TOKEN` has no default, and `registerAdmin` already fails closed when unset. |
| CX-03 | New `packages/chains/src/tron/tron-tx-verify.ts`. The broadcaster re-derives the signing hash from `raw_data_hex`, asserts `sha256(raw_data_hex) == txID`, and decodes the protobuf to check owner, destination, amount, token contract, `call_value` and the exact `transfer(address,uint256)` calldata before signing. |
| CX-04 | `apps/api/src/policy-config.ts` — `assertPolicyConfigured` refuses to boot on mainnet when the authorization key, approvals, time-lock, per-payout ceiling or velocity cap are unset, naming what each absence would mean at runtime. Logs loudly on testnet. |
| CX-05 | `Engine.broadcaster` now exposes the *authorized* broadcaster; the fee sweep and the gas station use it. Both mint an authorization token for their transfer via `mintInternalAuthorization`, so an engine-originated transfer clears the same signing-boundary check a tenant payout does. |
| CX-06 | `apps/api/src/tenant-scope.ts` — an `AsyncLocalStorage` scope entered in an `onRequest` hook, plus a `SqlClient` wrapper that binds `cixtech.tenant` transaction-locally on every statement issued inside it. RLS now filters; the admin plane and background loops run unscoped and keep cross-tenant reads. |
| CX-07 | `registerAi` takes `buildApp`'s `tenantOf` and asserts a scope per route: `read` for the two GETs and the query, `move-funds` for rule creation. The private re-implementation is gone. |
| CX-08 | `@fastify/rate-limit` with two buckets — a generous per-credential one and a much tighter per-IP one for requests that fail authentication. Keyed on the SHA-256 of the credential, never the credential. `/health` and `/ready` are exempt. |
| CX-09 | `apps/api/src/webhook-url.ts` — https only, no embedded credentials, no infrastructure ports, and no loopback / link-local / private / CGNAT / v4-mapped-IPv6 target. Checked when the URL is set *and* again immediately before each delivery (DNS rebinding), with redirects refused. `lastError` is coarsened to a category before it reaches the tenant. |
| CX-10 | `parseScopes` plus a `scopes` field on tenant creation, key issuance and rotation. An approve-only credential is now expressible, which is what makes dual control mean anything. |
| CX-11 | The fall-through query selects `occurred_at` (the column that exists) and joins through `posting` to filter by tenant. The fabricated `isSolvent: true` is replaced by a real `LedgerService.isSolvent` call, and the misleading `generatedSql` echo is gone. |
| CX-12 | Authentication, validation, scope and rate-limit failures are counted in metrics but no longer written to the append-only `error_log`. |
| CX-13 | `@fastify/helmet` with a CSP including `frame-ancestors 'none'`, plus HSTS, `nosniff` and `no-referrer`. |
| CX-14 | `/metrics` requires the admin bearer token (constant-time compare) unless `CIXTECH_PUBLIC_METRICS=true`. |
| CX-15 | `fastify` → ^5.12.3, `vitest` → ^3.2.6, plus pnpm `overrides` forcing patched `fast-uri`, `find-my-way`, `nanoid`, `esbuild`, `postcss` and `vite`. |
| CX-16 | `assertCustodyModelAcknowledged` refuses to start mainnet custody unless `CIXTECH_ACKNOWLEDGE_HOT_KEY=true` records that a hot in-process key is the intended posture. Boot logs the model explicitly, and the build spec's "threshold MPC" promise is corrected. **Moving the key into a KMS/HSM is still outstanding — see below.** |
| CX-17 | `DELETE /v1/accounts/:id/allowlist`, effective immediately. `add` also returns the *stored* `usable_at` via `RETURNING`, so a re-add no longer reports a cool-down that is not in force. |
| CX-18 | Three-stage `Dockerfile`: production dependencies only, pre-bundled entry points, and a non-root `USER node`. Postgres and Redis are no longer published to the host. |
| CX-19 | `transferCommitment` uses a length-prefixed encoding, so a caller-controlled idempotency key containing spaces can no longer produce a colliding commitment. |
| CX-20 | `randomUUID()` for rule and anomaly ids. |
| CX-21 | `conditionThreshold` carries `pattern: "^[0-9]+$"`, matching the withdrawal schema. |
| CX-22 | The zero-day-drain detector filters on `added_at`, not `usable_at`. |
| CX-23 | `assertValidDestination` validates against the chain's own encoder at allow-list time and at withdrawal request time — before a lease is taken or funds are locked. |
| CX-24 | `esc()` escapes `'` in both consoles. |

### Still yours to do

Two items cannot be closed from inside the repository:

1. **Rotate the exposed key material (CX-01, CX-02).** The default `xprv` and admin
   token are removed from `docker-compose.yml`, but they remain in git history and
   must be treated as burned: generate a new xprv, sweep every address derived
   from the old one, rotate the admin token, and purge both from history.
2. **Move the signing key out of the API process (CX-16).** The engine now refuses
   to start mainnet custody without an explicit acknowledgement, which makes the
   risk a recorded decision rather than an accident — but it is still one hot key
   in the process that terminates public HTTP. The `Signer` port is the seam for a
   KMS/HSM or the MPC signing domain.

---

## Coverage note

Eleven findings are marked **proven** because a test was run and its output is quoted above; the
remainder are confirmed by reading the wiring. Chain-adapter parsing, the ledger's double-entry
invariants, and the reconciliation paths had a lighter read than the HTTP and money-out surfaces and
would repay a focused second pass.
