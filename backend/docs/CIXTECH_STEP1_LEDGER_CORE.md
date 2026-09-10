# cixtech — Build Step 1: Ledger core + config spine

*Build-order step 1 from `CUSTODY_ENGINE_BUILD_SPEC.md` §17. This is the one step
with **zero external dependencies** — no keys, no chains, no network — so it can
start today and it is where the accounting is *proven* before anything can move
money.*

## Scope

**In:** the double-entry ledger (accounts, postings, balances, solvency
invariant, internal reconciler) and the config spine (per-`(chain, env)`
chain-config + token registry, no-magic-constants lint).

**Explicitly out** (later steps): any `Signer`/MPC, any `ChainAdapter`, any
detection/RPC, the policy engine, the API. Step 1 imports **nothing** from a
chain or a key. If a test needs a chain, it belongs in a later step.

**Definition of done:** every property below is green under Vitest + fast-check;
the no-magic-constants lint rule fails CI on a hardcoded chain ID / RPC / token
address; `make test PKG=ledger` proves the invariant across
generated event histories including reorgs, replays, and concurrency.

## Package layout

```
cixtech/
├── packages/          # NOTE: the workspace was flattened — packages/<x>/src is now
│                   # backend/src/<x>, imported as @/<x>. See DEPLOYMENT_TOPOLOGY.md.
│   ├── types/                     # @cixtech/types — shared enums + branded types
│   │   └── src/
│   │       ├── money.ts           # Asset, AmountBaseUnits (bigint), Decimal helpers
│   │       ├── account.ts         # AccountType, LedgerAccountKey (branded)
│   │       └── ids.ts             # TenantId, AccountId, JournalEntryId (branded)
│   │
│   ├── ledger/                    # @cixtech/ledger — PURE double-entry core
│   │   ├── src/
│   │   │   ├── account.ts         # account taxonomy + normal-balance rules
│   │   │   ├── entry.ts           # JournalEntry / Posting value objects
│   │   │   ├── balanced.ts        # invariant: postings sum to zero per asset
│   │   │   ├── posting-flows.ts   # deposit / payout / fee / reversal builders (ADR 0010)
│   │   │   ├── solvency.ts        # Σ ASSET ≥ Σ LIABILITY, per asset
│   │   │   ├── ledger.port.ts     # LedgerStore interface (persistence boundary)
│   │   │   ├── ledger.service.ts  # postEntry / getBalance / trialBalance / reconcileInternal
│   │   │   └── reconcile.ts       # internal reconciler (sum-to-zero, balance==history)
│   │   ├── src/adapters/
│   │   │   ├── memory-store.ts    # in-memory LedgerStore (fast algebraic properties)
│   │   │   └── prisma-store.ts    # Postgres LedgerStore (persistence properties)
│   │   └── test/                  # *.property.test.ts — see list below
│   │
│   └── chain-config/              # @cixtech/chain-config — the config spine (§16.5)
│       └── src/
│           ├── env.ts             # CHAIN_ENV = 'testnet' | 'mainnet'
│           ├── chains.ts          # per-(chain, env): chainId, finalityRule, gasParams
│           ├── tokens.ts          # token registry keyed by (chain, env, symbol)
│           └── registry.ts        # total lookups; throws on unknown (chain,env,symbol)
└── tooling/
    └── eslint-no-magic-constants/ # lint rule: no literal chainId / 0x-address / rpc URL
```

Both `ledger` and `chain-config` are **pure and framework-free** — no NestJS, no
Prisma types leaking past `ledger.port.ts`. NestJS wraps them in a later step.

## Ledger domain (what the code encodes)

**Account taxonomy** (ADR 0010), each with a *normal balance* side:

| Type | Normal side | Example keys |
| ---- | ----------- | ------------ |
| LIABILITY | credit | `merchant_available:{t}:{m}` · `merchant_pending:{t}:{m}` · `merchant_pending_withdrawal:{t}:{m}` · `compliance_suspense:{t}` |
| ASSET | debit | `pool_addr:{chain}:{m}` · `treasury:{chain}` · `cold:{chain}` · `gas_float:{chain}` |
| REVENUE | credit | `egofi_fee_revenue:{t}` · `engine_platform_revenue` |
| EXPENSE | debit | `network_fee_expense` |

**The three hard rules** (all property-tested):

1. A `JournalEntry` is accepted **iff** its postings sum to zero **per asset**.
2. A materialized `Balance` equals the signed sum of its account's postings —
   for **every** ordering of the same set.
3. The **solvency invariant** holds after any valid history:
   `Σ ASSET(pool_addr + treasury + cold + gas_float) ≥ Σ LIABILITY(available + pending + pending_withdrawal + compliance_suspense)`, per asset.

**Posting-flow builders** (from ADR 0010, pure functions `event → JournalEntry`):
`depositDetected`, `depositFinalized(fee)`, `payoutLocked`, `payoutSettled`,
`feeSwept`, `reverse(entry)`. Each returns a balanced entry or throws.

**Idempotency:** `postEntry` is keyed on the entry's `idempotencyKey`
(`(chain, txHash, index)` or `intentId`). Re-posting the same key is a no-op that
returns the original — never a second set of postings.

## Property-test list (the core of step 1)

Vitest + **fast-check**. Algebraic properties run against `memory-store`;
persistence/concurrency properties run against `prisma-store` on a
real PostgreSQL server that the suite starts itself (`@cixtech/testing`).

**Balance & entry algebra**
1. Every accepted entry sums to zero per asset; an unbalanced entry is **always
   rejected** and persists nothing.
2. For any generated multiset of postings, materialized balance == signed sum,
   independent of insertion order.
3. Decimal precision: no fee split or conversion loses or invents base units
   (`merchant_available + egofi_fee_revenue == deposit`, exactly, for all A, f).

**Idempotency & reorg**
4. Replaying an entry's `idempotencyKey` yields identical balances and no new
   postings (redelivered webhook can't double-credit).
5. `apply(deposit)` then `reverse(deposit)` returns **every** touched balance to
   its exact pre-deposit value (reorg safety).
6. Any interleaving of `{detect, finalize, reverse}` for independent deposits
   leaves the solvency invariant intact.

**Solvency invariant**
7. For any generated history of valid deposit/finalize/payout/fee/reversal
   events, `Σ ASSET ≥ Σ LIABILITY` holds per asset at every step.
8. A payout for more than `merchant_available` is **rejected** — no negative
   liability balance is ever reachable.
9. ADR 0009 identity holds continuously:
   `pool_addr:{chain}:{m} == merchant_available + accrued-unswept egofi_fee_revenue`.

**Concurrency (prisma-store)**
10. N concurrent `postEntry` calls to the same account never lose an update
    (optimistic `version`); final balance == serial application of the same set.
11. Two posts sharing an `idempotencyKey` racing → exactly one set of postings.

**Internal reconciler**
12. `reconcileInternal` reports zero drift on any valid history, and **non-zero
    drift** if a posting is mutated out-of-band (mutation testing — the reconciler
    must actually catch it, not rubber-stamp).

**Config spine**
13. Token-registry lookup is **total** for every supported `(chain, env, symbol)`
    and **throws** (never returns a default) on an unknown triple.
14. The no-magic-constants lint rule fails on a literal chain ID, `0x…` address,
    or RPC URL anywhere outside `chain-config`.

## Tooling

- **Vitest** unit + property; **fast-check** generators for accounts, amounts
  (full `Decimal(36,18)` range), and event histories.
- **`@cixtech/testing`** starts a real PostgreSQL (`embedded-postgres`, no Docker)
  once per package and hands each test its own schema — persistence and
  concurrency properties need a real server with real connections.
- **Biome** + the custom `no-magic-constants` rule, wired into the CI gate
  (`CUSTODY_ENGINE_BUILD_SPEC.md` §3) so `packages/ledger` + `packages/policy`
  cannot merge without property tests.
- Money: `decimal.js` for display math, `bigint` base units on all boundaries —
  never a float (principle 4).

## Why this is step 1

A custody business fails by losing the keys or losing track of the liabilities.
Step 1 de-risks the second — cheaply, deterministically, with no key or chain in
sight — and ships the config spine that keeps the eventual testnet→mainnet switch
a config swap (§16.5). Nothing in later steps is allowed to move value until
these properties are green.
