# ADR 0012: Every error has a stable id and is persisted for audit

**Status:** Accepted

## Context

In a licensed custodian, an error is not just a log line — it is potential
incident evidence. When a withdrawal is rejected, a deposit fails to credit, or
the solvency check trips, support and compliance need to trace *that exact
occurrence* across logs, the action audit trail (ADR 0010's `AuditLog`), and any
report to a regulator. Ad-hoc `throw new Error("...")` gives none of that: no
identity, no machine-readable class, no durable record.

## Decision

**Every error carries a stable `id` at construction and is persisted to an
error-audit store under that id.**

- A shared `AppError` base (`@cixtech/errors`) assigns a UUID `id` and timestamp
  on construction, and requires a machine-readable `code`. All domain errors
  extend it (ledger: `LEDGER_UNBALANCED_ENTRY`, `LEDGER_INVALID_POSTING`,
  `LEDGER_INSUFFICIENT_FUNDS`; config: `CONFIG_NOT_FOUND`, `CONFIG_INVALID_ENV`).
- `toErrorRecord(unknown)` normalizes **any** thrown value — including a stray
  plain `Error` or a thrown string — into an `ErrorRecord` with an id, so the
  guarantee is *every* error, not just the well-typed ones. Unclassified errors
  are marked non-exposable.
- An `ErrorSink` port is the persistence boundary; `captureError(sink, err)` is
  the single choke point that assigns/persists and returns the record so the
  caller can surface `record.id`. An in-memory sink exists now; the
  Postgres-backed sink lands with the ledger persistence layer.
- **Two projections, strictly separated:** `toRecord()` (full — stack + context)
  goes only to the audit sink; `toPublic()` returns `{ id, code, message }` to an
  external caller and leaks neither stack nor context. A non-exposable error
  returns a generic message but *keeps its id*, so a caller can still quote it to
  support.
- The API layer's global exception filter (future) runs every caught error
  through `captureError`, logs it (pino, structured), and returns `toPublic()`
  with the id. Money-movement errors are audited unconditionally.

## Consequences

- Support and compliance can join a user-quoted id across logs, the error-audit
  store, and the action `AuditLog` (ADR 0010) — one correlation id end to end.
- The `ErrorSink` port keeps the pure core (ledger, chain-config) free of any
  persistence dependency; only the composition/API layer wires the real sink.
- `context` is for structured, non-sensitive detail and must pre-stringify
  bigints (base-unit amounts) so records are JSON-safe.
- Error records are audit data under the licence's retention rules (ADR 0008);
  the Postgres sink must honour that retention and never be pruned ad hoc.
