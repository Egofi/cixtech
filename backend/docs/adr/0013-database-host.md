# ADR 0013: Database host — Neon for dev/CI and egofi; the custody ledger is licence-gated

**Status:** Accepted (ledger-host decision deferred to the licence)

## Context

"Can we use Neon?" — Neon is serverless Postgres (separated storage/compute,
autoscaling, scale-to-zero, database branching). The question spans two very
different consumers: the egofi PSP app and dev/CI, versus the **custody ledger**,
which is the most compliance-sensitive component we run (ADR 0008, 0010).

Key facts (verified 2026-07):

- **It is just Postgres.** Prisma supports it via a pooled `url` + a direct
  `directUrl` for migrations — which maps *exactly* onto egofi's existing
  `DATABASE_URL` / `DIRECT_DATABASE_URL` split. Adopting Neon is a config/deploy
  choice, not a code change: our `LedgerStore` port already makes the DB host
  swappable.
- **Pooling caveats.** Neon fronts connections with PgBouncer in *transaction*
  mode. Session-level `SET` and prepared statements don't survive across the
  pool (set `pgbouncer=true`; use the direct URL for migrations). Our RLS pattern
  uses transaction-local `SET LOCAL` *inside* a transaction, which is fine — but
  must be verified on Neon before relying on it.
- **Scale-to-zero cold starts** are wrong for a settlement engine (they delay
  deposit detection and withdrawals). Production compute must pin a minimum
  (disable scale-to-zero), which erodes the serverless cost advantage.
- **Data residency is the blocker.** Neon has a limited region set, **no African
  region**, is US-incorporated (CLOUD Act reach even for non-US regions), and its
  compliance attestations are SOC 2 + HIPAA. A project is locked to one region
  and cannot be migrated.

## Decision

- **Adopt Neon now for: dev, CI, and the egofi PSP app.** Its branching is
  excellent for ephemeral per-PR databases; the `url`/`directUrl` split fits our
  Prisma setup directly. (Integration tests still run against a hermetic
  Postgres the suite starts itself; Neon branching is an optional later
  convenience.)
- **Do NOT commit the custody ledger to Neon yet.** The ledger host is a
  **licence-gated decision** (ADR 0008): Nigerian DASP data-residency and
  provider-eligibility conditions must be confirmed first. Because the
  `LedgerStore` port makes the host swappable, this decision can be made late
  without code churn.
- **Nothing hardcodes Neon.** Host, pooling, and region are config (§16.5); the
  Prisma adapter is written against plain Postgres semantics.

## Consequences

- egofi and developer velocity get Neon's benefits immediately.
- The custody ledger's production host stays open until the licence answer lands;
  the likely outcome is a pinned, single-region, PITR-enabled managed Postgres in
  a compliance-approved region — Neon **if** residency clears, otherwise a
  managed Postgres (e.g. RDS/CloudSQL) or self-managed in an approved region.
- Scale-to-zero must be disabled on any production compute that backs settlement.

## Addendum (verified 2026-07, on Neon)

The engine now runs on managed Postgres behind a `pg.Pool` (`apps/api/src/db.ts`);
`pnpm db:migrate` applies the schema and verifies the items below. There is no
embedded fallback: a missing `DATABASE_URL` is a boot failure, and the server
refuses to start against an unmigrated database rather than running DDL as a
start-up side effect.

**RESOLVED — transaction-mode pooling + RLS.** The previously-open `[DECISION]`
is answered: `withTenant` binds tenant isolation with `set_config(..., true)`
(transaction-local), and that survives Neon's PgBouncer pooler intact — it binds
inside the transaction and does not leak to the next request on that connection.
The migration command asserts both on every run and fails if either breaks.

**NEW — a policied database is not an isolated one.** RLS is enforced per *role*,
and Neon's default `neondb_owner` carries `rolbypassrls = true`. Connecting the
engine with it makes §13 completely inert: the tables are ENABLEd, FORCEd, and
policied, `pg_policies` lists everything, the boot guard passes — and no row is
ever filtered. `ENABLE ROW LEVEL SECURITY` alone was also insufficient, since
Postgres exempts a table's owner unless the table is `FORCE`d.

Two consequences, both now enforced:

- Tables are `FORCE ROW LEVEL SECURITY`, so ownership is not an exemption.
- The engine connects as a dedicated `NOBYPASSRLS NOSUPERUSER` role
  (`pnpm db:migrate --create-app-role`), not as the database owner. The owner URL
  is kept for migrations only, as `DIRECT_DATABASE_URL`.

That role is also where ADR 0010's append-only guarantee stops being a convention:
it holds `SELECT, INSERT` but **not** `UPDATE`/`DELETE` on `journal_entry`,
`posting`, `admin_audit`, and `error_log`, so a bug or a compromised API process
cannot rewrite the financial or audit trail. Corrections remain reversing entries,
now because the database refuses anything else.

**Generalizes beyond Neon.** Any managed Postgres that hands you an elevated
default role has this shape. Treat "which role does the engine connect as" as part
of the host decision, not a deployment detail.
