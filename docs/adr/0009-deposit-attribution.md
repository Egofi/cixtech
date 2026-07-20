# ADR 0009: Per-merchant address pools that hold balance; sweep only on payout

**Status:** Accepted

## Context

Custody (ADR 0006) needs every inbound payment attributed to exactly one
account. HD derivation offers unlimited fresh addresses, so the naive design is
one address per deposit, never reused, swept to treasury on arrival.

That naive design pays gas **twice** for every payment: once to sweep the
deposit into treasury, and again to pay the merchant out. On small tickets the
eager sweep can cost more than the deposit is worth. It also recreates, inside
the engine, exactly the fragmentation-and-dust problem that made merchant-side
xpub sweeping painful in the first place.

## Decision

**Each merchant gets a bounded, dedicated pool of addresses per chain. Deposits
stay where they land. The only sweep is the merchant's payout.**

```
AVAILABLE → RESERVED  (exclusively assigned to ONE invoice)
          → IN_USE    (deposit detected, below finality)
          → COOLING   (deposit final AND payment window closed + grace)
          → AVAILABLE (retains its balance; reusable for the next invoice)
```

- **Exclusive assignment is what the pool buys.** One invoice per address at a
  time makes attribution trivial — any deposit to this address in this window
  belongs to this invoice. No amount-matching required.
- **Cool-off releases at deposit finality *and* window-closed + grace, whichever
  is later.** Not at sweep. The grace period exists for **late payments**: if an
  invoice expires, its address returns to the pool, is reassigned, and the
  original customer then pays late, that deposit would be mis-attributed to the
  new invoice. egofi's existing `AmountReservation.cooldownUntil` already
  encodes this instinct (`COOLDOWN_MULTIPLIER = 2` — twice the payment window).
- **Addresses hold balance while `AVAILABLE`.** There is no `SWEPT` state.
  Funds move exactly once: when the merchant requests a payout.
- **Atomic claim** via `SELECT … FOR UPDATE SKIP LOCKED`, so two concurrent
  checkouts never claim the same address. (Generalizes the atomic `xpubIndex`
  increment already in `DirectTransferRail`.)
- **Attribution is per-transaction**, keyed `(chain, txHash, index)` — never per
  address balance. A reused address accumulating many deposits is fine.

**Two strategies, one interface:**

| Strategy | Chains | Mechanism |
| -------- | ------ | --------- |
| `PooledAddressStrategy` | Polygon, BSC, Arbitrum, Base, Tron, BTC, LTC | dedicated per-merchant pool, lifecycle above |
| `SharedAccountTagStrategy` | **XRP** | one custodian account, per-deposit **destination tag**, ledger-only attribution |

**XRP cannot use pooled addresses.** Its per-account base reserve permanently
locks XRP per address, so address-per-merchant is economically absurd. Tag-based
attribution on a single account is the standard pattern (and the future path for
XLM/EOS/Cosmos memo chains). The pool assumption must not leak into the core.

## Consequences

- **One on-chain movement per payment instead of two.** Gas is paid lazily, only
  when money actually needs to move, and only for funds the merchant actually
  withdraws.
- **The bounded pool bounds the fragmentation.** A merchant with 500 deposits
  across a 10-address pool accumulates into **10 addresses, not 500** — so
  payout gather cost is capped by pool size, not deposit count. The pool *is*
  the consolidation mechanism. This is what dissolves the xpub dust problem
  rather than relocating it.
- **Payout gather cost is chain-shaped:** UTXO chains spend N pool inputs in one
  cheap tx; EVM/Tron need a gas-funded transfer *per* funded address — mitigated
  by CREATE2 forwarders (relayer-paid, batched, send-only-to-master), the launch
  choice over EIP-7702 for the gather (`CUSTODY_ENGINE_BUILD_SPEC.md` §6.5). Pool
  size is therefore a direct payout-cost lever on account-model chains.
- **Pooling is most justified on Tron**, independently: each fresh Tron address
  costs to activate and energy is staked *per account*, so unbounded fresh
  addresses burn TRX on activation and waste staked energy. Reuse amortizes both.
- **There is no cold storage in this model — the entire float is online.** Every
  satoshi sits in an address that must stay spendable on request. This is the
  design's real cost and it is a licence and insurance conversation (ADR 0008),
  not a technical footnote. Two mitigations that preserve the economics:
  - put pool addresses in a **warm-tier key domain** (3-of-5, no auto-signing) —
    affordable precisely *because* payouts are infrequent and merchant-initiated
    rather than per-deposit;
  - **idle-balance consolidation** — sweep only balances untouched for N days to
    cold, which sits off the pool's critical path entirely.
  **[DECISION]** adopt one, both, or accept a fully-online float.
- **Accrued fee revenue is physically scattered** across pool addresses and needs
  its own periodic revenue sweep, separate from merchant payouts (ADR 0010).
- Per-merchant on-chain pools give clean, demonstrable **client-asset
  segregation** — a licence asset, not just an implementation detail. Address
  count is not attack surface: HD derivation means one key domain regardless.
- Pool size per (merchant, chain) is a tuning knob: too small starves checkout
  during the cool-off window, too large fragments the payout gather and inflates
  monitoring cost. It is not a constant.
