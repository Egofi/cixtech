# Plan — consolidating SQL into query modules

**Status:** done — all six phases complete
**Decision:** query modules over Kysely (not an ORM) — see [ADR 0022](adr/0022-kysely-query-builder.md) for why not Prisma; the same three objections apply to MikroORM and TypeORM
**Scope:** 160 raw `sql.query(...)` call sites across 29 files

## The problem, measured

SQL is written as string literals at the point of use, so the same table is
queried from many unrelated files and no query has a name.

| table | queries | written in |
| --- | ---: | --- |
| `pool_address` | 16 | 6 files, incl. 3 services |
| `balance` | 14 | 6 files, incl. 2 services and 2 AI engines |
| `posting` | 10 | 4 files |
| `webhook_delivery` | 10 | 3 files |
| `principal` | 12 | 1 file |

Two consequences.

**A column rename is a search-and-hope.** `pool_address` is read in
`pool.store.ts`, `pool-group.store.ts`, `fee-sweep.service.ts`,
`admin.service.ts`, `portal.service.ts` and `balance-cache.ts`. Nothing connects
those six.

**Services talk to the database directly.** `admin.service.ts` issues **25**
queries and `portal.service.ts` **7**. A service should orchestrate stores, not
open connections. Those 32 are the layering violation this plan also closes.

Of the 159 literal queries parsed, **130 are expressible in the query builder**,
**19 must stay raw**, and 18 touch no table at all (DDL, GUC binding, catalogue
introspection) and are not in scope.

## The shape

One module per table in `src/queries/`, exporting **named queries that return a
Kysely builder**. This is Django's `QuerySet`/manager pattern: the query is
defined once, called in one line, and still composable because the caller
receives a builder rather than a finished result.

```ts
// src/queries/pool-address.queries.ts
import type { Db } from "@/types";

export const poolAddress = {
  ordered: (db: Db) =>
    db
      .selectFrom("pool_address")
      .select(["chain", "address"])
      .orderBy("chain")
      .orderBy("derivation_index"),

  forTenant: (db: Db, tenant: string) => poolAddress.ordered(db).where("tenant", "=", tenant),
};
```

The call site loses its SQL entirely:

```ts
// before — src/attribution/balance-cache.ts
const { rows } = await this.sql.query<{ chain: string; address: string }>(
  "SELECT chain, address FROM pool_address ORDER BY chain, derivation_index",
);

// after
const rows = await poolAddress.ordered(this.db).execute();
```

`rows` is typed from the generated schema, so `chain` and `address` are checked
against the real columns rather than asserted by hand.

**Composition is why this is a module and not a repository class.** A caller that
needs the same query with one more filter writes
`poolAddress.ordered(db).where("chain", "=", "TRON")` instead of asking for a new
method. Named queries stay few; refinements stay at the call site.

## What stays raw, and why

Nineteen queries keep hand-written SQL. Kysely's `sql` template is the escape
hatch, and each one earns it:

- **Upserts with expressions** (14 of the 19) — the ledger's
  `ON CONFLICT ... DO UPDATE SET amount = balance.amount + EXCLUDED.amount,
  version = balance.version + 1`. The arithmetic on `EXCLUDED` is the atomic
  balance update; expressing it through a builder obscures the one statement the
  solvency invariant rests on.
- **`FOR UPDATE` row locks** (2) — the gather lease and the deposit cursor.
- **Catalogue introspection** — `assertTenantTablesProtected` reads `pg_class`
  and `pg_policies`. Those are not application tables and will never be in `DB`.
- **The GUC binding** — `set_config('cixtech.tenant', $1, true)` in
  `tenantScopedSql`. It must stay exactly as it is; it is the RLS control.

These are wrapped in a named query too, so the call site still reads as one line;
only the body is raw.

## Order of work

Each phase ends green — typecheck, lint, guard, full suite — before the next
starts.

**1 — Foundation.** Add `Db` (`Kysely<DB>`) to `@/types`, create `src/queries/`
with its barrel, and a `queries/README` note stating the one rule: a query module
never imports from `src/services` or `src/stores`.

**2 — The five hot tables** — `pool_address`, `balance`, `posting`,
`journal_entry`, `webhook_delivery`. 64 of the 160 call sites, and every one of
the multi-file offenders. Highest value first; if the approach is wrong, it is
wrong here and cheap to abandon.

**3 — Auth and tenancy** — `principal`, `principal_totp`,
`principal_recovery_code`, `auth_session`, `auth_attempt`, `tenant`, `api_key`,
`account`. Mostly single-file, mechanical.

**4 — The service-layer fix.** `admin.service.ts` and `portal.service.ts` stop
taking a `SqlClient`. Their 32 queries move behind stores, which call the query
modules. This is the phase with real behavioural risk — the admin plane reads
across tenants deliberately, so the tenant-scoping tests must stay green
throughout.

**5 — The remainder** — policy, payout, gather, idempotency, AI, error log.

**6 — Enforce it.** A test that fails on a raw SQL string literal outside
`src/queries/` and `src/schemas/`, so the scatter cannot come back. Without this,
phase 1–5 decay.

## Risks

- **32 service queries move across a layer boundary.** Behaviour must not
  change; the admin/portal e2e suites and `tenant-scope.test.ts` are the
  guardrail. This is the phase to do slowly.
- **Two ways to write a query until phase 6.** Some stores are on the builder,
  some on strings. Unavoidable in an incremental migration, and the reason phase
  6 exists.
- **Kysely does not check what raw SQL does.** The 19 escape-hatch queries keep
  exactly the risk they have today — no worse, no better.
- **`ApprovalStore` is already converted** (ADR 0022) and will need rewriting to
  the module shape. It is small.

## Outcome

**160 raw call sites → 26**, and every one of the 26 is deliberate: the
`cixtech.tenant` GUC binding, the migration runner's own `schema_migration`
bookkeeping, `pg_catalog` introspection that proves RLS is on, and a `SELECT 1`
readiness probe. Thirteen query modules under `src/queries/`. No service and no
store writes SQL any more.

Three defects surfaced while converting, none of which the old code could have
caught:

- **A row type that was lying.** `tenant.store.ts` declared `created_at: string`,
  but `pg` returns `timestamptz` as a `Date`. The hand-asserted row type hid it;
  the wire format was only correct because `JSON.stringify` ISO-formats Dates.
  The same lie existed in `payout-journal.ts`.
- **Columns missing from the generated types.** `api_key.revoked_at` and
  `payout_intent.requested_by` are added by `ALTER TABLE ... ADD COLUMN`, which
  the generator did not read. 181 → 183 columns. The drift check could not have
  found this, because it compares generated output against generated output.
- **Hand-counted parameter indexes.** `admin.service.ts` built two filtered
  queries by concatenating SQL and counting `$${params.length}` by hand. Adding a
  filter out of order would silently shift another one's placeholder. Both now
  use `$if`.

Nineteen queries kept hand-written SQL and each earns it: the ledger's
`amount = balance.amount + EXCLUDED.amount`, the drift-detection join, three
`FOR UPDATE SKIP LOCKED` claims (pool address, webhook delivery, gather lease —
each one the reason two workers cannot take the same work), the gather lease's
`WHERE pool_gather_lease.expires_at < $3` conflict guard, `COUNT(*) OVER ()`, and
the fee-revenue interval aggregate. All are named queries; only the body is raw.

## Verification

`test/queries/no-scattered-sql.test.ts` is phase 6. It fails on any table query
written outside `src/queries` and `src/schemas`, and — because an exemption list
rots — it also fails when an exemption names a file that no longer exists or no
longer contains SQL. That second check earned its keep immediately: it rejected
an exemption for `route-access.ts` that was never needed, since route keys like
`"DELETE /auth/sessions/:id"` do not match `DELETE FROM`.

Re-adding a `SELECT ... FROM pool_address` to `balance-cache.ts` fails it with
the file and the offending snippet quoted.

Existing coverage carries the rest: the ledger property tests (solvency, idempotency,
balance algebra), `tenant-scope.test.ts` for the RLS binding, `rls.test.ts` for
policy presence, and the admin/portal e2e suites. A refactor that keeps 382 tests
green while removing SQL strings is the whole claim, so no new behavioural tests
are needed — only the phase-6 guard, which is a lint, not a test of behaviour.
