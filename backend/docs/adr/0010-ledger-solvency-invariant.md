# ADR 0010: Double-entry ledger with a continuously enforced solvency invariant

**Status:** Accepted

## Context

Once we hold other people's money (ADR 0006), the ledger — not the chain — is
the record of who owns what. On-chain balances are merely where value enters and
exits. A custody business fails in exactly two ways: it loses the keys, or it
loses track of the liabilities. ADR 0007 addresses the first; this addresses the
second.

egofi's existing `LedgerEntry` is a single-entry stub whose write methods
(`recordFee`, `recordPayout`) are never even called. It cannot carry custody.

## Decision

A **double-entry, append-only, immutable ledger**. Corrections are reversing
entries, never edits.

```
account    typed LIABILITY | ASSET | REVENUE | EXPENSE, namespaced per tenant
  LIABILITY  merchant_available:{t}:{m}  merchant_pending:{t}:{m}
             merchant_pending_withdrawal:{t}:{m}  compliance_suspense:{t}
  ASSET      pool_addr:{chain}:{m}   ← the working float lives here (ADR 0009)
             treasury:{chain}        ← swept fee revenue
             cold:{chain}            ← idle-balance consolidation, if adopted
             gas_float:{chain}
  REVENUE    egofi_fee_revenue:{t}   engine_platform_revenue
  EXPENSE    network_fee_expense
journal_entry  a group; postings MUST sum to zero per asset
posting        one debit/credit; idempotency-keyed on (chain, txHash, index)
balance        materialized (account, asset), versioned for optimistic concurrency
```

**Deposit of A, fee f = 0.5%** (funds stay in the pool address — ADR 0009):

```
detected:   DR pool_addr_unconfirmed:{chain}:{m} A   CR merchant_pending A
finality:   reverse pending
            DR pool_addr:{chain}:{m}  A
            CR merchant_available     A·(1−f)
            CR egofi_fee_revenue      A·f      ← accrued, still physically pooled
payout W:   DR merchant_available W   CR merchant_pending_withdrawal W   (locked)
  finality: DR merchant_pending_withdrawal W
            CR pool_addr:{chain}:{m} W         ← the ONLY time funds move
            DR network_fee_expense
fee sweep:  DR treasury:{chain}       CR pool_addr:{chain}:{m}
            DR network_fee_expense             ← realizes scattered accrued revenue
```

**`pool_addr` is the primary asset account, not a way-station.** Deposits are
credited at finality and the coins stay put; the only movement is the merchant's
payout. So at any moment:

```
pool_addr:{chain}:{m}  ==  merchant_available  +  accrued-but-unswept egofi_fee_revenue
```

Treasury accounts receive only **fee sweeps** and (if adopted) **idle-balance
consolidation** — never a per-deposit sweep. This is what makes the solvency
check map to real on-chain locations rather than a fiction.

**The solvency invariant, enforced continuously, per asset:**

```
Σ ASSET(pool_addr + treasury + cold + gas_float)
      ≥  Σ LIABILITY(available + pending + pending_withdrawal + compliance_suspense)
```

Two reconcilers run every cycle:

- **internal** — postings sum to zero; materialized balances match posting history.
- **external** — every ledger ASSET account equals the *actual on-chain balance*
  reported by an independent indexer.

Any drift **trips the circuit breaker: withdrawals freeze and a human is paged.**

**Fee layering — two independent planes:**

| Plane | Account | Charged by | To |
| ----- | ------- | ---------- | -- |
| Engine infra fee | `engine_platform_revenue` | the custodian entity | its tenants (incl. egofi) |
| egofi take (0.5%) | `egofi_fee_revenue:{t}` | egofi | its merchants |

The engine exposes a per-sub-account fee-split policy so egofi delegates its
0.5% to the engine's postings (single source of truth for money movement) while
the engine also charges egofi its platform fee on top.

**Tainted deposits never auto-credit.** A high-risk KYT result posts to
`compliance_suspense` — held, not credited — and escalates. Deposits are
unilateral: anyone can send us sanctioned funds, and returning them to source is
a legal question, not an obvious kindness. Reuses `COMPLIANCE_HOLD` (ADR 0005).

## Consequences

- The invariant is simultaneously the bug tripwire, the internal-fraud tripwire,
  and the **proof-of-reserves backbone** — which ADR 0008's licence requires.
- Proof of reserves publishes per-asset liabilities from the ledger plus
  cryptographic control of reserve addresses, with a **Merkle tree of
  liabilities** so any customer verifies their own inclusion without seeing
  others'.
- Reorg safety comes free from idempotency keys: a removed tx triggers a
  compensating reversing entry; `pending` states prevent premature credit;
  redelivered webhooks cannot double-post.
- Per-tenant namespacing + the existing RLS discipline yields per-tenant trial
  balances, statements, and per-tenant proof-of-reserves.
- Every fund movement is auditable end-to-end — extend the existing `AuditLog`
  rather than inventing a second trail.
