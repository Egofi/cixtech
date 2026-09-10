# ADR 0022: Kysely over the SqlClient port, and why not Prisma

**Status:** accepted, adopted incrementally
**Related:** [ADR 0013](0013-database-host.md), [ADR 0018](0018-session-management.md)

## Context

166 raw `sql.query(...)` call sites across 8 store adapters write SQL as string
literals with positional parameters. The types of the rows they return are
asserted by hand at each call site (`query<{ amount: string }>`), so a column
rename is caught by nothing until runtime.

Prisma was the obvious candidate. It is the wrong tool for this engine, for three
specific reasons.

**1 — Row-level security is a per-transaction GUC.** Fourteen tables run
`FORCE ROW LEVEL SECURITY` against `current_setting('cixtech.tenant', true)`, and
`tenantScopedSql` wraps *every* query in a transaction that first runs
`set_config('cixtech.tenant', $1, true)`. The third argument is what makes it
transaction-local, and therefore safe under a connection pool. Prisma offers no
hook to inject a statement at the head of every query's transaction; the honest
implementation routes every tenant-scoped call through `$transaction` plus
`$executeRaw`, which abandons the Prisma API exactly where tenant isolation lives.

**2 — Money is `numeric` read as `bigint`.** The ledger selects `amount::text`
and parses it with `BigInt(...)`. Every balance, every posting and the solvency
invariant (Σ ASSET ≥ Σ LIABILITY) are exact integer base units. Prisma maps
`numeric` to `Decimal`, so adopting it puts a type conversion through the highest
risk code in the product.

**3 — It contradicts ADR 0018.** That ADR rejected Argon2id — the better password
primitive — because "a native dependency in the image that holds the signing key
is a real supply-chain cost." Prisma ships a Rust query-engine binary. The same
objection applies, an order of magnitude larger.

Prisma Migrate would also replace a migration runner that checksums each schema
module, reports one that has **changed since it was first applied**, and asserts
at boot that every tenant table still carries an RLS policy.

## Decision

**Kysely, compiled through the existing `SqlClient` port.**

Kysely is a query builder, not an ORM: no engine binary, no entity mapping, no
migration tool, and its output is the SQL you would have written.

### The driver delegates rather than connects

The obvious wiring — Kysely's own `PostgresDialect` with its own `pg.Pool` —
would have been a tenant-isolation bug. It opens its own connections, so queries
would bypass `tenantScopedSql` and run with no `cixtech.tenant` bound. Under a
policy that reads `current_setting(...) IS NULL OR ... = tenant`, an unbound GUC
means **every tenant's rows are visible**.

So the dialect owns no connection. `SqlClientDriver.acquireConnection` hands back
a connection whose `executeQuery` calls `SqlClient.query(compiled.sql,
compiled.parameters)`. Whatever client the store was constructed with — the raw
pool, or the tenant-scoped wrapper — is what the query runs on. RLS is unchanged
because nothing about the execution path changed.

### Transactions stay with SqlClient

`beginTransaction` throws, naming the pattern that keeps the GUC bound:
`sql.transaction((tx) => ... kyselyFor(tx))`. Kysely's imperative
begin/commit does not map onto `SqlClient`'s callback-scoped transactions, and
the existing implementation already nests via savepoints. Rather than emulate it
badly, the query builder builds queries and the port owns transactions.

### The SQL stays the source of truth

`types/ports/db.ts` — 28 tables, 181 columns — is **generated** from
`src/schemas/sql/` by `pnpm db:types`, not hand-written and not introspected from
a live database. The schema files remain what creates the tables; the types are
derived from them, so the two cannot disagree. Regeneration is byte-identical,
which makes a drift check a diff.

`numeric` and `bigint` map to `string`, matching what `pg` actually returns, so
call sites keep parsing to `bigint` themselves. No `Decimal` enters the ledger.

### The SQL schema files stay

Kysely does not create tables, so nothing about adopting it makes the DDL
redundant. Replacing `src/schemas/sql/` with Kysely's own migration API would
mean giving up `applySchemas` — which checksums each module and reports one that
has *changed since it was first applied* — and `assertTenantTablesProtected`,
which refuses to boot if a tenant table has lost its RLS policy.

It would also mean re-expressing, through a builder, DDL that carries the
engine's invariants rather than merely its shape: `CHECK (amount > 0)` on every
posting, `CHECK (direction IN ('DEBIT','CREDIT'))`, the `principal_tenant_shape`
constraint that stops a `tenant_user` existing with a NULL tenant (ADR 0018), 15
RLS policies, 23 indexes and 10 foreign keys. Most of those need a raw `sql`
escape hatch in any builder, so the rewrite would trade readable SQL for
TypeScript wrapping the same SQL.

The types are generated *from* the DDL, so the database describes itself and
TypeScript follows. `pnpm db:types:check` runs first in `pnpm check` and fails
the build when the two disagree — the one failure mode this arrangement has is
someone editing a schema file and forgetting to regenerate.

## Consequences

**Better.** Column names and row types are checked against the real schema.
Parameterisation is structural rather than a positional convention. `pnpm
db:types` after a schema change turns a rename into a compile error.

**Costs, honestly.**

- **Adoption is incremental and currently one store deep.** `ApprovalStore` is
  converted; seven remain on raw SQL. Both styles work through the same port, so
  this can proceed store by store — but until it finishes, there are two ways to
  write a query, which is its own kind of thing to look twice at.
- **The generator is a parser, not Postgres.** It reads `CREATE TABLE` statements
  with a small hand-rolled column parser. It already had one bug — SQL `--`
  comments contain commas, and stripping them after splitting produced four
  phantom columns on `principal`. It is checked by the typechecker and the suite
  rather than trusted.
- **Kysely cannot express everything here.** The ledger's `ON CONFLICT ... DO
  UPDATE SET amount = balance.amount + EXCLUDED.amount` and the RLS/GUC
  statements stay raw. Kysely's `sql` template escape hatch exists; the point is
  that conversion is a judgement per query, not a sweep.
- **One more dependency in the runtime image**, though a pure-TypeScript one with
  no postinstall step and no binary.

## Verification

`test/postgres/kysely.test.ts` (5) pins the properties that make this safe: a
Kysely query compiles to parameterised SQL and is issued on the injected client,
with the literal absent from the text; a query inside `runAsTenant` binds
`cixtech.tenant` exactly once; the same query outside a tenant scope binds
nothing, so the admin plane still reads across tenants; a Kysely-level
transaction is refused with a message naming the correct pattern; and the
converted `ApprovalStore` still records once, refuses a duplicate, and blocks
self-approval.
