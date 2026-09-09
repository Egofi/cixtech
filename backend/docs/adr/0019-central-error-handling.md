# ADR 0019: One error catalogue, one entrance

**Status:** accepted, implemented
**Implements:** the "global exception filter (future)" left open by [ADR 0012](0012-error-identity-and-audit.md)

## Context

ADR 0012 gave every error an id, a `code`, and two projections. What it did not
give was a single place that decides what an error *means* to a caller.

That decision had settled into a hand-maintained literal in `src/api/app.ts`:

```ts
const STATUS: Record<string, number> = { UNAUTHORIZED: 401, ... };
await reply.status(STATUS[err.code] ?? 400).send({ error: err.toPublic() });
```

`Record<string, number>` accepts any key, so nothing ever failed when a new
error class was added and the map was not. It had drifted: **50 error classes,
30 entries.** Twenty-two codes reached the fallback — nineteen to `?? 400`, and
three (which extended plain `Error`) to a generic 500 — and the result was not
merely untidy.

- `SIGNING_KEY_UNAVAILABLE` — the engine cannot reach its signing key — answered
  **400 Bad Request**. The caller is told they sent a bad request; nothing pages
  anyone; the retry that would succeed after failover never happens.
- `LEDGER_UNBALANCED_ENTRY` — the double-entry invariant broke — answered **400**.
  A solvency-class incident was indistinguishable from a typo in a request body.
- `CHAIN_MISCONFIGURED`, `CONFIG_NOT_FOUND`, `TRON_TX_MISMATCH` — all operator
  faults, all reported to the client as its own fault.

Two further leaks followed from the same place. `exposable` was decided
per-throw-site, so a 5xx could carry its internal message outward if any call
site passed `exposable: true`. And `NOT_WORTH_PERSISTING` was a second literal
list of codes, maintained separately from the first and drifting independently.

Error classes were also scattered across twenty-five modules — `auth-store.ts`
defined six of them between its imports and its first method — so no reader
could see the error surface, and nothing could check it.

## Decision

**A code's meaning is declared once, in a catalogue the compiler checks, and
every entrance resolves failures through it.**

### The catalogue is total, by type

```ts
export const ERROR_CATALOGUE: Record<ErrorCode, ErrorPolicy> = { ... };
```

`ErrorCode` is the union of the per-module code unions in `types/errorTypes/`.
`Record<ErrorCode, …>` is **total**: adding a code without a policy fails
`tsc`, and so does a policy for a code that does not exist. The drift that
produced twenty-two unmapped codes is now a compile error rather than a silent
`?? 400`. Each class narrows its own `code` to its module's union, so a typo in
a code string fails to compile too.

A policy carries four decisions, not one:

| field | answers |
| --- | --- |
| `status` | what the caller is told |
| `severity` | `expected` \| `warning` \| `critical` — whether anyone should look |
| `exposable` | whether the message may leave the process |
| `retryable` | whether trying again could work |

`severity` replaces the `NOT_WORTH_PERSISTING` list: a record is persisted when
`severity !== "expected"`, so the persistence decision is derived from the same
declaration as the status and cannot drift from it.

### Exposability is a policy, narrowable but not wideable

```ts
isExposable() { return this.policy.exposable && this.exposable; }
```

A call site can still hide a message. It **cannot** reveal one the catalogue
says is internal. Two tests hold the line: no policy with `status >= 500` is
exposable, and no 5xx is `severity: "expected"`.

### Types in `types/errorTypes/`, code in `src/common/`

Codes and shapes are types (`AuthErrorTypes.ts`, `LedgerErrorTypes.ts`, …).
Throwables are runtime (`AuthException.ts`, `LedgerException.ts`, …), gathered in
`src/common/exceptions/` and re-exported through its `index.ts`; the machinery that
acts on them — `catalogue.ts`, `handler.ts`, `sink.ts`, `sql-sink.ts` — sits beside
it in `src/common/errors/`, and `src/common/index.ts` is the single import surface:

```
src/common/
  errors/       catalogue, handler, sink, sql-sink
  exceptions/   AppException + one file per module
  routes/       one file per plane + route-access
  index.ts
```

Each module keeps an abstract base (`AuthException`, `LedgerException`) so
`catch (e) { if (e instanceof LedgerException) }` is available without listing
subclasses.

### One entrance, three callers

`resolveError(unknown) -> { status, severity, record, body, persist }` is
framework-agnostic — `src/common/` imports no Fastify — and normalises an
`AppError`, a framework validation failure, a framework 4xx, a framework 5xx and
a thrown string into the same envelope. `handleError` adds the sink write and
the critical-path callback.

- **HTTP** — `setErrorHandler` is now four lines over `handleError`.
- **Unmatched routes** — `setNotFoundHandler` previously did not exist, so
  Fastify's default answered `{"message":…,"error":"Not Found","statusCode":404}`
  while every other failure answered `{"error":{"id","code","message"}}`. A
  client parsing `error.code` got `undefined`. It now goes through the same path.
- **Worker** — had **no** error capture at all: a failed job went to BullMQ's
  retry and no `ErrorRecord` was ever written. Every worker's `failed` event now
  runs `handleError` against the same `SqlErrorSink` the API uses, so a job
  failure and a request failure land in one table under one id.

`SqlErrorSink` moved from `src/api/admin/` to `src/common/errors/` so the worker does
not import from the API layer to reach it.

## Consequences

**Status codes changed.** Sixteen codes previously answered `400` (or, for the
three classes that extended plain `Error`, a generic `500`) and now answer what
they mean:

| code | was | now |
| --- | --- | --- |
| `SIGNING_KEY_UNAVAILABLE` | 400 | 503, critical, retryable |
| `LEDGER_UNBALANCED_ENTRY` | 400 | 500, critical |
| `TRON_TX_MISMATCH` | 400 | 500, critical |
| `CHAIN_MISCONFIGURED`, `CONFIG_NOT_FOUND`, `CONFIG_INVALID_ENV` | 400 | 500 |
| `MPC_NODE_REJECTED`, `MPC_BAD_CONTRIBUTION` | 400 | 502 |
| `MPC_THRESHOLD_NOT_MET` | 400 | 503, retryable |
| `MPC_INTERIM_FORBIDDEN` | 400 | 403 |
| `POOL_ADDRESS_NOT_FOUND` | 400 | 404 |
| `POOL_CONCURRENT_MODIFICATION`, `POOL_INVALID_TRANSITION` | 400 | 409 |
| `LEDGER_DUPLICATE_ENTRY_ID`, `SWEEP_HALTED` | 400 | 409 |
| `GATHER_BUSY` | 500 | 409, retryable |

The response envelope is unchanged, so the consoles' `ApiError` type still
holds. A client that branched on the *status* of one of those codes will see the
new one; a client that branched on `error.code` is unaffected.

**`FEE_TREASURY_NOT_CONFIGURED` deliberately stays 400 and exposable.** It reads
like an operator fault, but it is raised on the admin fee-sweep route and the
operator reading it is the person who can fix it. Burying the message behind
"An internal error occurred" would hide the only actionable part.

**Costs, honestly.**

- **The catalogue is a chokepoint.** Every new error code is a two-file change:
  the module's code union and the catalogue. That is the point — the compiler
  refuses the one-file version that caused the drift — but it is friction.
- **`policyFor` still has a `?? UNCLASSIFIED_POLICY` fallback.** The type makes
  it unreachable for a declared code; it exists for a value that crossed a
  runtime boundary (a code read back from the database, a cast in a test) and
  fails closed at 500, non-exposable.
- **Class names still end in `Error`, not `Exception`.** The files are
  `AuthException.ts` and the module bases are `…Exception`, but the fifty
  throwables keep their existing names — they are `instanceof Error` and are
  referenced across the tests. Renaming them is a separate mechanical change.
- **Tests are still outside `tsconfig`'s `include`.** The exhaustiveness
  guarantee is compile-time for `src/` and `types/` only, which is why the
  catalogue's totality is *also* asserted at runtime in
  `test/common/error-catalogue.test.ts`.

## Verification

`test/common/` (21) covers the properties as failures they prevent: every
declared code has exactly one policy and every policy a reachable code; no
exception class maps to a missing policy; no 5xx is exposable; no 5xx is routine;
an infrastructure failure answers 503 rather than 400; a withheld message still
carries its correlation id; a validation failure, a framework 4xx, a framework
5xx and a thrown string each land in the one envelope; routine rejections are
not persisted while everything else is; only a critical failure raises the alarm;
an unmatched route answers in the same envelope as everything else.
