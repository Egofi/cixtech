# ADR 0011: A swappable gather-strategy port; CREATE2 forwarders at launch, EIP-7702 later

**Status:** Accepted

## Context

The payout gather on account-model chains (ADR 0009) has more than one viable
mechanism, and they are not equivalent for a licensed custodian:

- **EOA fund-then-transfer** — simple, gas-dust-heavy, per-address.
- **CREATE2 forwarders** — permissionless deploy, relayer-paid, batchable,
  structurally send-only-to-master, and works on Tron (TVM has CREATE2).
- **EIP-7702 delegation** — standard HD-EOA addresses, native gas-abstraction,
  but EVM-only, newer, and its authorization must be MPC-signed by the deposit
  key itself (so it is not signature-free like a forwarder deploy).

We want to run exactly one of these per chain, switch between them without a
redeploy, and keep a fast fallback if a strategy's dependency breaks.

**The hard constraint that shapes the switch:** the two strategies produce
**different addresses for the same derivation index** — a CREATE2 forwarder
address is `keccak(factory, salt, initcodeHash)`; a 7702 address is the plain HD
EOA. A pool address that has received funds is therefore permanently committed to
the strategy that created it. You cannot flip a *funded* address between
strategies — only one mechanism knows how to drain it.

## Decision

Introduce a **`GatherStrategy` port** with the gather mechanism selected by
**per-`(chain[, tenant])` config**, mutually exclusive, and switchable at
runtime under dual control.

- **Each `PoolAddress` records the `gatherStrategy` it was minted under.** Gather
  logic dispatches **per-address on that recorded tag, never on the current
  global toggle.**
- **The toggle is forward-only.** Flipping it changes only which strategy *new*
  addresses are minted under. Existing addresses keep draining under their
  original strategy via normal payouts / idle-consolidation until the pool has
  rotated over; then the old strategy retires. This is a **forward-only cutover
  with a drain tail**, not a hot swap.
- **Tron is hard-pinned to forwarders** — a *capability* limit (no 7702 on
  Tron), not a preference. Config must reject selecting 7702 on Tron, not
  silently accept it.
- **Flipping the strategy is a fund-movement change** → same dual-control +
  audit-logged discipline as a policy change (build spec §7).

**Sequencing (chosen):** build the **port + per-address tag now**; ship
**CREATE2 forwarders as the sole implementation** across all EVM chains + Tron;
add **EIP-7702 as the second strategy** when its contained wins justify the
second audit. Do **not** run two full gather stacks in production before then —
that doubles the audited fund-movement surface, the most expensive thing to
double for a custodian. The toggle exists as a day-one architectural affordance;
the second implementation lands when warranted.

Independently of the gather choice, **EIP-7702 is adopted for two contained
wins** on the EVM chains (build spec §6.5): gas abstraction (retire the native
`gas_float` balances in favour of stablecoin-sponsored gas) and treasury /
withdrawal smart-accounts (batched, session-key-governed payouts without
ERC-4337). Those are separate from the deposit-side gather toggle.

## Consequences

- One gather pattern (forwarders) covers **all EVM chains and Tron** at launch —
  no second mechanism to maintain on day one.
- The toggle buys a **kill-switch** (disable a compromised 7702 delegate
  instantly, drain its addresses), **canary rollout**, and **outage fallback**
  (paymaster/relayer failure ≠ payout freeze) — all config-only.
- **Stranding risk is the failure mode to engineer against:** a mis-built toggle
  that dispatches on the global flag instead of the per-address tag would strand
  balances at addresses nobody can gather from. The per-address `gatherStrategy`
  tag is load-bearing, not cosmetic.
- **`chain_id = 0` is forbidden for any 7702 authorization** (build spec §6.5):
  one MPC key derives the same address on all four EVM chains, so a chain-agnostic
  delegation would delegate it everywhere at once. Always per-chain; the delegate
  contract must be minimal, immutable, and separately audited.
- UTXO (BTC/LTC) and XRP are unaffected — they have no gather strategy to select
  (UTXO gathers natively; XRP uses shared-account + tag).
