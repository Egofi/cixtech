# ADR 0021: Layer folders for services, stores and schemas

**Status:** accepted, implemented
**Related:** [ADR 0019](0019-central-error-handling.md), [ADR 0020](0020-route-catalogue.md)

## Context

The engine was organised by domain — `chains/`, `ledger/`, `attribution/`,
`auth/`, `api/` — and each domain held everything it needed. That is a coherent
architecture, but it had drifted into three specific ways of making a reader
look twice.

**The same word meant two things.** `src/api/schemas.ts` held Fastify request
validation. `src/api/api-schema.ts` held SQL DDL. Same folder, near-identical
names, unrelated jobs.

**Layering was applied in one module and nowhere else.** `worker/` had
`services/`, `stores/` and `workers/`. No other module did, even though four of
them contained services and six contained stores. `worker/services/` was empty.

**Migration leftovers shadowed real files.** `src/api/chains/build-router.ts`,
`deposit-cursor.ts` and `evm-deposit-source.ts` were one-line re-exports of
`@/chains`, left from the monorepo split. Two were imported by nothing. A reader
searching for `buildRouter` found two files, one of which was a decoy. Three more
shims did the same for `@/postgres`, `@/chains` webhooks and `SqlClient`.

Thirteen SQL table definitions were spread across ten files: five in dedicated
schema files, eight embedded in feature files beside unrelated logic.

## Decision

**Cross-cutting kinds get top-level folders; domains keep their own logic.**

```
src/
  services/     5 services            admin, portal, payout, fee-sweep, ledger
  stores/       8 store adapters      tenant, auth, pool, approval, policy, …
  schemas/
    sql/        13 table definitions  every CREATE TABLE in the engine
    http/       Fastify validation
  common/
    errors/ exceptions/ routes/
  ai/ api/ attribution/ auth/ chain-config/ chains/ ledger/ mpc/
  postgres/ signing/ worker/

types/
  enums/        AccountType, Scope
  models/       branded ids, money, account keys + one file per domain
  ports/        SqlClient
  errorTypes/   error codes per module
  routeTypes/   route access shapes
```

### Data shapes live in `types/`, behaviour stays in `src/`

Of 184 exported types in `src/`, **119 were pure data shapes** — records with no
methods and no function-typed members — declared next to the logic that happened
to use them first. They now sit in `types/models/<domain>.ts`, one file per
domain, reachable through `@/types`.

The **65 that stayed** did so for a reason, not by omission:

- **46 are behavioural ports** — `LedgerStore`, `PayoutBroadcaster`, `KillSwitch`,
  `ChainAdapter`, `ErrorSink`. An interface with methods is a contract about what
  something *does*; it belongs with the domain that defines the collaboration, and
  moving it would invert the dependency so that `types/` described behaviour.
- **9 are derived from runtime values** (`typeof ROUTE_KEYS`, `typeof
  ADMIN_ROUTES`) and cannot outlive the constant they are derived from.
- **10 reference a runtime symbol** — `Engine`, `AdminOptions`, `PolicyConfig`,
  `BuiltRouter` — so moving them would make `types/` import from `src/`.

The rule is mechanical rather than a matter of taste: **no methods and no
function-typed members, and every type it references is itself movable.**

Two duplicates surfaced while applying it. `ChainFamily` was declared
byte-identically in `chain-config/chains.ts` and `chains/chain-adapter.ts`.
`FinalityRule` was declared in both under one name with **two different shapes** —
`readonly confirmations` plus an optional `note` in one, a mutable
`confirmations` in the other. Both now have a single definition; nothing assigned
to `confirmations`, so the stricter `readonly` form was safe to keep.

Naming is one rule per kind: `<name>.service.ts`, `<name>.store.ts`,
`<name>.schema.ts`. `ledger.service.ts` had been the only dot-named service among
five; it is now the pattern rather than the exception.

**Ports stay with their domain.** `LedgerStore` lives in `ledger/ledger.port.ts`
and `PoolStore` in `attribution/pool.port.ts`; their SQL and in-memory adapters
live in `stores/`. The port is the domain's contract, the adapter is an
implementation of it, and keeping the contract next to the code that depends on
it is what stops `stores/` becoming a dependency of everything.

**Barrels no longer re-export what moved.** When `LedgerService` moved, the
temptation was to leave `export * from "@/services/ledger.service.js"` in
`ledger/index.ts` so nothing broke. That is exactly the decoy the deleted shims
were, so consumers were repointed at `@/services` instead. One symbol, one import
path.

## Consequences

**Better.** Every service, every store and every table definition is findable in
one place. The `schemas.ts` / `api-schema.ts` collision is gone. Six dead files
are gone. Two independent definitions of the tenant scope list — `SCOPES` in the
tenant store and `TenantScope` in the route types — were found during the move
and collapsed into `types/enums/scope.ts`; adding a scope is now one edit.

**Costs, honestly — and one was argued against.**

- **This splits cohesive domains, and that was the objection.** A change to
  payouts now touches `chains/payout/` (policy, broadcasters), `services/`
  (payout.service.ts), `stores/` (approval, policy) and `schemas/sql/`. Under the
  previous layout it touched one directory. The trade was made deliberately: kind
  is easier to find, feature is harder to change. It is the standard cost of
  layer-first organisation and it will be felt on every payout change.
- **`src/api/` still holds thirteen loose files** — composition roots (`app.ts`,
  `server.ts`, `engine.ts`), migration wiring (`sql.ts`, `migrate.ts`, `rls.ts`)
  and small helpers. They are neither services nor stores, and inventing a folder
  per pair would be worse than leaving them.
- **`RLS_SCHEMA_SQL` stayed in `api/rls.ts`.** It is computed from `TENANT_TABLES`
  rather than written as SQL, and it ships with the assertion that verifies it. It
  is the one table-shaping thing not under `schemas/sql/`.
- **`schemas/http/` needed a tsconfig change.** It cannot compile under
  `exactOptionalPropertyTypes`, so `tsconfig.api.json` now includes it and
  `tsconfig.json` excludes it — the same split `src/api/**` already had.

## Verification

`pnpm check` — lint, both typecheck configs, the magic-constant guard and 377
tests — is green, unchanged in count across every phase of the move. A
test-inclusive typecheck reports the same six pre-existing test-type errors as
before the move and no missing symbols, so no import was silently dropped. The
full stack rebuilds with all five services healthy.
