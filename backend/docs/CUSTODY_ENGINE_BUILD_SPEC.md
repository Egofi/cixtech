# cixtech — Custody Engine Build Specification (TypeScript)

**Owner:** Nuelgreen AI
**Product:** **cixtech** — the custody engine.
**Nature:** Multi-tenant, licensed crypto-custody infrastructure (Wallet-as-a-Service)
**Core promise:** *A business calls one API to give its users deposit addresses, hold balances, and pay out — while a licensed custodian holds the keys, and every satoshi is provably backed.*

> **Key custody, as actually deployed today.** The launch path signs with a single
> HD key loaded from `CIXTECH_ENGINE_XPRV` into the API process (ADR 0007's
> documented interim). Threshold MPC is implemented in `backend/src/mpc` but is **not**
> wired into the production signing path. On mainnet the engine refuses to start
> unless `CIXTECH_ACKNOWLEDGE_HOT_KEY=true` records that this is deliberate. Do not
> describe the deployed system as MPC-backed until the signer is swapped — see
> `docs/SECURITY_AUDIT.md` (CX-16).

egofi is the **first tenant**, not the owner. The engine knows nothing about
invoices, checkouts or merchants — it knows **tenants, accounts, deposits,
withdrawals, and fees**. This separation is the entire business: egofi proves the
engine in production, then the engine is sold to other PSPs, exchanges, neobanks
and payroll apps.

Governing decisions: [ADR 0006](docs/adr/0006-custody-stance.md) (custody),
[0007](docs/adr/0007-in-house-threshold-mpc.md) (MPC),
[0008](docs/adr/0008-licensed-custodian-entity.md) (licence/entity),
[0009](docs/adr/0009-deposit-attribution.md) (attribution),
[0010](docs/adr/0010-ledger-solvency-invariant.md) (ledger).

---

## 0. Non-negotiable design principles

1. **The ledger is the truth; the chain is an I/O device.** Balances are ledger
   positions. On-chain state is where value enters and exits, and is reconciled
   against the ledger — never trusted as the record of ownership.
2. **The full private key never exists.** Not at generation, not at signing, not
   in recovery. Threshold shares only, HSM-sealed, quorum-gated.
3. **The policy engine is the security boundary; MPC is the last mile.** Signing
   is what happens *after* authorization, never the place authorization happens.
4. **Fail closed.** Policy unreachable, solvency drifting, gas float dry,
   reconciler failing → withdrawals stop. Never fail open on money movement.
5. **Every fund movement is authorized, attributed, audited, and reversible in
   the ledger** (by compensating entry — postings are immutable).
6. **Custody is a licensed activity.** Every design decision is also a
   compliance decision (§14). Client-asset segregation must be *provable*.
7. **Multi-tenant from line one.** A single-tenant custody engine is a feature;
   a multi-tenant one is a business. Never let egofi's assumptions leak in.
8. **No magic constants.** Every chain ID, RPC URL, and token address comes from
   per-`(chain, env)` config (§16.5). testnet and mainnet are separate
   deployments with separate keys — never an in-place flag.

---

## 1. Repository & codebase layout

**Resolved: a separate repo** (`cixtech`), owned by the custodian legal entity
(ADR 0008) — different licence surface, different audit scope, different access
control. Publish `@cixtech/types` + `@cixtech/sdk` as private packages so egofi
consumes them the way it already consumes `@egofi/sdk`.

```
cixtech/
├── apps/
│   ├── api/          # NestJS — tenant-facing REST + webhooks (public, gateway-fronted)
│   ├── worker/       # BullMQ — detection, payouts, gas station, reconciliation
│   ├── coordinator/  # MPC session coordinator (never holds shares)
│   └── console/      # Next.js — internal ops: approvals, policy, treasury, PoR
├── nodes/
│   └── signer/       # the MPC signing node — deployed n× in ISOLATED trust domains
├── packages/
│   ├── types/        # shared DTOs, enums, chain configs
│   ├── sdk/          # typed client (tenants + egofi)
│   ├── ledger/       # double-entry core (pure; heavily property-tested)
│   ├── policy/       # rule evaluation + authorization tokens (pure)
│   ├── chains/       # ChainAdapter implementations
│   └── tss/          # threshold-signature protocol (audited separately)
└── docs/adr/
```

**`nodes/signer` is not an app.** It is deployed n times into separate cloud
accounts / regions / operator domains and is the only code with share access. It
has its own release process, its own reviewers, minimal dependencies, and
reproducible builds.

## 2. Standard stack

Inherit egofi's stack — same language, same discipline, same CI gate — so the
two products stay operable by one team.

| Concern | Choice | Why |
| ------- | ------ | --- |
| Language | TypeScript (strict) | Same as egofi; `tsc --noEmit` + `noUncheckedIndexedAccess` |
| API | NestJS + Fastify | Module/DI maps onto the adapter abstractions, as in egofi |
| Data | PostgreSQL + Prisma | Ledger integrity needs real transactions + constraints |
| Jobs | BullMQ (Redis) | Same reasoning as [ADR 0003](docs/adr/0003-bullmq-not-temporal.md) |
| Validation | Zod | Every external boundary: chain data, tenant input, provider responses |
| TSS | **CMP** (GG21/CMP family), audited | Threshold ECDSA on secp256k1; supports proactive share refresh (§10). Audit vendor still **[DECISION]** |
| HSM | **CloudHSM / KMS custom keystore** | Share sealing + attestation |
| Chain access | Own nodes + indexer, **not** a single vendor | Reconciliation must use an *independent* source from detection |
| KYT/sanctions | Chainalysis / TRM / Elliptic | **[DECISION]** provider |
| Travel Rule | TRISA / Notabene / Sygna | **[DECISION]** network |
| Money math | `decimal.js` + base-unit `bigint` | Never floats. Base units on chain boundaries |

**Independent-source rule:** the reconciler must read chain balances from a
*different* provider than the deposit detector. A single vendor being wrong in
both places would make the solvency invariant agree with itself and prove
nothing.

## 3. Code-quality gate

Identical to egofi (Biome + strict `tsc` + Vitest + branch protection), plus
custody-specific gates:

- **`packages/ledger` and `packages/policy` require property-based tests.**
  Postings sum to zero for all generated inputs; the solvency invariant holds
  across all generated event orderings, including reorgs and replays.
- **`packages/tss` and `nodes/signer` require two reviewers** and cannot be
  merged by their author.
- **No `any`, no floating promises, no floats in money paths** — CI-enforced.

## 4. The core abstractions (the spine)

Three ports. Everything else is orchestration.

```ts
interface Signer {                       // ADR 0007 — swap MPC in without a rewrite
  deriveAddress(domain: KeyDomain, path: string): Promise<Address>;
  sign(req: {
    domain: KeyDomain; path: string; sighash: Uint8Array;
    authorization: AuthorizationToken;   // nodes re-verify this independently
  }): Promise<Signature>;
}

interface ChainAdapter {
  family: 'EVM' | 'UTXO' | 'TRON' | 'XRP';
  attribution: AttributionStrategy;
  parseDeposit(raw: unknown): DepositEvent[];      // idempotent on (txHash, index)
  finalityPolicy(): FinalityRule;
  buildSweep(from: Address[], to: Address, asset: Asset): UnsignedTx;
  buildWithdrawal(from: Address, to: Address, asset: Asset, amt: bigint): UnsignedTx;
  estimateFee(tx: UnsignedTx): Promise<FeeEstimate>;
  broadcast(signed: SignedTx): Promise<TxId>;
  getBalance(addr: Address, asset: Asset): Promise<bigint>;   // independent source
}

interface AttributionStrategy {          // ADR 0009
  assign(tenant: TenantId, account: AccountId, chain: Chain): Promise<DepositTarget>;
  // → { address } | { address, destinationTag }
  release(target: DepositTarget): Promise<void>;
}

interface GatherStrategy {               // ADR 0011 — swappable per chain, mutually exclusive
  readonly kind: 'FORWARDER' | 'EIP7702' | 'EOA_FUND_TRANSFER';
  mintAddress(domain: KeyDomain, path: string): Promise<PoolAddress>;  // tags the address
  buildGather(addrs: PoolAddress[], to: Address, asset: Asset): UnsignedTx;  // dispatch is per-address
}
```

`Signer` is defined day one and backed initially by a **single HSM-guarded,
capped hot wallet** while the in-house MPC matures on testnet (ADR 0007). The
cutover changes one binding.

`GatherStrategy` (ADR 0011) is selected by per-`(chain[, tenant])` config, but
**dispatch is per-address on the strategy each `PoolAddress` was minted under —
never on the current toggle** (§6.5). Launch ships `FORWARDER` only.

## 5. Module map (NestJS)

| Module | Owns |
| ------ | ---- |
| `tenants` | tenant registration, API keys, scoped credentials, per-tenant config |
| `accounts` | sub-accounts (a tenant's merchants), balances |
| `attribution` | the address pool + cool-off lifecycle, tag allocation |
| `detection` | chain watchers + the polling safety net; emits `DepositEvent` |
| `ledger` | double-entry postings, balances, trial balance, statements |
| `policy` | rule evaluation, authorization tokens, approvals, limits |
| `withdrawals` | intent → policy → sign → broadcast → settle |
| `treasury` | key-domain tiering, gas station, payout gathers (via `GatherStrategy`, ADR 0011), fee sweeps |
| `compliance` | KYT, sanctions, Travel Rule, holds, case management |
| `reconciliation` | internal + external reconcilers, circuit breaker, PoR |
| `signing` | `Signer` port, MPC coordinator client |
| `webhooks` | outbound signed events via transactional outbox |

## 6. Supported chains, gas & treasury

### 6.1 Chain matrix

| Chain | Family | Attribution | Gas reality |
| ----- | ------ | ----------- | ----------- |
| Polygon, BSC, Arbitrum, Base | EVM | pooled address | ERC-20 sweep needs **native gas in the address** |
| Tron | Tron | pooled address | energy/bandwidth; **account activation costs**; stake TRX |
| BTC, LTC | UTXO | pooled address | fee comes **out of the UTXO** — no pre-funding |
| XRP | XRP | **shared account + destination tag** | trivial fee; **base reserve locks XRP per account** |

All eight sign with **secp256k1** — one threshold scheme (ADR 0007).

### 6.2 The gas station

Where custody engines quietly break. Per family:

All of this is paid at **payout** time, not per deposit (§6.3).

- **EVM — three gather patterns** (see §6.5 for the full comparison):
  *fund-then-transfer* on plain EOAs (simple; 2 txs per funded address; leaves
  gas dust); **CREATE2 forwarder contracts** (permissionless, relayer-paid,
  batchable, structurally send-only-to-master, and works on Tron too); or
  **EIP-7702 delegation** (standard HD EOAs, native gas-abstraction, but
  EVM-only and newer). **Start EOA; move to CREATE2 forwarders at volume for the
  gather; adopt 7702 for gas-abstraction and treasury smart-accounts (§6.5).**
- **Tron** — stake TRX for energy (or rent it) rather than burning ~13–30 TRX
  per USDT transfer. Budget address **activation** cost per new pool address —
  a direct argument for a bounded, reused pool (ADR 0009).
- **UTXO** — a payout naturally **spends many pool UTXOs as inputs to one tx**,
  so gathering is nearly free here. Set a **dust threshold** below which a UTXO
  costs more to spend than it holds; fold it into a future gather or leave it.
  RBF/CPFP for stuck txs.
- **XRP** — maintain the base reserve; the account can never be paid below it.

`gas_float:{chain}` is a **first-class ASSET account**. If it runs dry, payouts
on that chain stall silently → monitor, auto-replenish, **trip the circuit
breaker on depletion**.

### 6.3 Funds stay put; the payout *is* the sweep (read this twice)

There is **no per-deposit sweep** (ADR 0009). Deposits are credited at finality
and remain in the merchant's pool address; the address returns to `AVAILABLE`
holding its balance. Money moves **exactly once**, when the merchant requests a
payout. Consequences that drive the rest of this section:

- **Gas is paid once, lazily, and only on funds the merchant actually
  withdraws** — not twice (deposit→treasury, treasury→merchant) on every ticket.
- **The bounded pool bounds the fragmentation.** 500 deposits across a
  10-address pool accumulate into **10 addresses, not 500**, so payout gather
  cost is capped by pool size, not deposit count. The pool *is* the
  consolidation mechanism.
- **Pool size is a payout-cost lever on account-model chains.** UTXO chains
  spend N pool inputs in one cheap tx; EVM/Tron need a gas-funded transfer per
  funded address. Size the pool small enough to keep gathers cheap, large enough
  that cool-off never starves checkout.
- **Sweeps are payout-triggered and merchant-initiated**, therefore infrequent
  and latency-tolerant — which is what lets the pool key domain sit at warm-tier
  quorum (§6.4) instead of hot auto-signing.

### 6.4 Treasury tiering (reshaped by §6.3)

Because funds live in pool addresses, the classic hot/warm/cold pyramid does not
apply as-is. **The float is online by construction** — every satoshi sits in an
address that must stay spendable on request. This is the design's real cost, and
it is a **licence and insurance conversation** (ADR 0008), not a footnote.

| Domain | Holds | Movement |
| ------ | ----- | -------- |
| **pool (warm-tier)** | **the working float — customer funds** | payout only; 3-of-5, no auto-signing |
| treasury | swept fee revenue; idle-balance consolidation | policy-gated |
| cold | consolidated idle balances *(if adopted)* | human quorum + time-lock |

Two mitigations preserve the economics — **[DECISION]** adopt one, both, or
accept a fully-online float:

1. **Warm-tier pool domain** — 3-of-5, no auto-signing. Affordable *precisely
   because* payouts are merchant-initiated and infrequent, unlike per-deposit
   sweeps.
2. **Idle-balance consolidation** — sweep only balances untouched for N days to
   cold. Sits entirely off the pool's critical path; never blocks checkout.

**Fee revenue is physically scattered** across pool addresses (ADR 0010) and
needs its own periodic sweep, separate from merchant payouts.

Payouts, fee sweeps and idle consolidation are all withdrawals from the engine's
perspective — **same policy engine, different rule set**.

### 6.5 EVM gather: forwarders vs. EIP-7702

Confirmed live: EIP-7702 is on all four EVM chains (Polygon, BSC, Arbitrum,
Base) post-Pectra. **Not on Tron** — 7702 is EVM-only.

**The pivotal custody fact:** a 7702 delegation tuple `[chain_id, address, nonce,
…]` must be signed by **the deposit address's own key**. That key is MPC-derived,
so producing a 7702 authorization is *itself an MPC signing session*. A CREATE2
forwarder, by contrast, is deployed **permissionlessly by a factory** — the
deposit key never signs. So 7702 does not make the gather MPC-free; it relocates
one MPC op to a one-time, per-address setup (bounded by pool size).

Both patterns converge on the same architecture, because one MPC signature
cannot authorize pulling from N *different* pool keys: **cheap/no-MPC gather to
master → one MPC-signed master→merchant hop**, sponsored and batched. The
non-functional differences decide it:

| Factor | CREATE2 forwarder | EIP-7702 delegate |
| ------ | ----------------- | ----------------- |
| Battle-tested in custody | a decade of exchange use | new (2025), thin custody track record |
| Structural send-only-to-master | yes, by construction | only if delegate hardcoded + audited |
| One pattern incl. Tron | **yes** (TVM has CREATE2) | **no — EVM-only** |
| Setup signature from deposit key | none (permissionless) | one MPC auth per address |
| Address derivation | separate counterfactual scheme; becomes a contract | standard HD EOA; stays an EOA |
| Gas abstraction (pay in stablecoin) | partial | native |
| Attack surface | single-purpose, minimal | **permanent, unrestricted account access** |

**Decision (ADR 0011 — the `GatherStrategy` port):**

- Both mechanisms sit behind a **`GatherStrategy` port**, selected by
  per-`(chain[, tenant])` config, **mutually exclusive**, switchable at runtime
  under dual control.
- **The switch is forward-only with a drain tail.** The two strategies produce
  *different addresses for the same index* (forwarder = `keccak(factory, salt,
  initcodeHash)`; 7702 = plain HD EOA), so a *funded* address is permanently
  committed to the strategy that minted it. Each `PoolAddress` records its
  `gatherStrategy`; **gather dispatches per-address on that tag, never on the
  current toggle.** Flipping the toggle only changes what *new* addresses mint
  as; old ones drain under their original strategy, then that strategy retires.
- **Sequencing:** build the **port + per-address tag now**; ship **CREATE2
  forwarders as the sole implementation** across all EVM chains + Tron; add
  **EIP-7702 as the second strategy** when its contained wins justify the second
  audit. Do not run two full gather stacks in production before then.
- **Tron is hard-pinned to `FORWARDER`** — a capability limit, not a preference;
  config must reject 7702 on Tron.
- **Independently, adopt 7702 for two contained wins:** (a) **gas abstraction** —
  retire the four native-token `gas_float` balances for a stablecoin-sponsored
  gas account; (b) **treasury/withdrawal smart-accounts** — batched,
  session-key-governed, sponsored payouts without ERC-4337. These are separate
  from the deposit-side gather toggle.

**Guardrail — never sign a 7702 authorization with `chain_id = 0`.** Zero means
"valid on all chains," and one MPC key derives the *same* EVM address on all four
chains — a `chain_id = 0` auth would delegate that address on every chain at once,
to whatever code sits at the pointer on each. **Always sign per-chain
authorizations.** The delegate implementation must be **minimal, immutable, and
separately audited**: it holds permanent unrestricted access and joins the trust
base of every delegated address alongside the MPC quorum.

**Stranding is the failure mode to engineer against:** a toggle that dispatches
on the global flag instead of the per-address `gatherStrategy` tag would strand
balances at addresses nobody can gather from. The tag is load-bearing.

## 7. The policy engine

Sits between intent and signing. **Fails closed.**

**Context:** tenant, account, asset, chain, amount, destination, allow-list
status + age, rolling velocity, KYT score, solvency state, requester identity,
approvals collected.

**Rules:**

1. **Limits** — per-tx, per-account/day, per-tenant/day, global/day.
   **Dual caps: an oracle-free native-asset hard ceiling (the real limit) plus a
   USD soft cap.** A USD-only limit depends on a price oracle, so a manipulated
   or stale oracle silently widens your caps.
2. **Allow-list + cool-down** — destination must be allow-listed; a newly added
   address is unusable for N hours. Defeats the attacker who adds their own
   address and drains in the same session.
3. **Velocity / anomaly** — rolling windows; deviation from the account's own
   baseline → step-up to manual review.
4. **Dual approval** — above threshold, M-of-N approvals from distinct
   operators; **the requester can never approve** (separation of duties).
5. **Time-lock** — above a higher threshold, enforce a delay before signing:
   the detection window that lets you cancel a compromised withdrawal.
6. **KYT / sanctions** — screen the destination; high risk → block or hold.
7. **Solvency gate** — refuse if the withdrawal breaks the invariant or the
   reconciler is in drift/circuit-breaker state.
8. **Kill switch** — per chain, per asset, per tenant, global.

**Outcomes:** `ALLOW | DENY(reason) | REQUIRE_APPROVAL(n) | HOLD(compliance) | DELAY(until)`.

**The authorization token** binds `{intentId, tenant, account, asset, chain,
amount, destination, derivationPath, sighash, policyVersion, approvals[],
decidedAt, expiresAt}`, signed by an HSM-held policy key, short-lived.

**Nodes must verify what they can evaluate independently** (ADR 0007) —
human-signed approvals, their own coarse rate limits, and **`sighash` binding**.
Verifying only "a token signed by the policy service" proves nothing if that
service is compromised.

**Policy change is itself policy-gated**: dual control, audit-logged, and
**effective only after a delay** — so an attacker owning the console cannot
raise limits and drain in one session.

**Ship a dry-run endpoint**: replay historical withdrawals against a candidate
policy before activating it.

## 8. Background jobs (BullMQ)

| Queue | Job | Cadence |
| ----- | --- | ------- |
| `detection` | chain watchers → `DepositEvent` | realtime |
| `detection-sweeper` | polling safety net for missed events | 1 min |
| `finality` | pending → confirmed at finality depth | per block |
| `withdrawal` | payout intent → policy → **gather from pool addresses** → sign → broadcast → settle | on merchant request |
| `gas-station` | fund EVM payout gathers, Tron energy, replenish float | continuous |
| `fee-sweep` | accrued `egofi_fee_revenue` from pool addresses → treasury | daily |
| `idle-consolidation` | balances untouched > N days → cold *(if adopted, §6.4)* | daily |
| `reconcile-internal` | postings sum to zero; balances match history | 5 min |
| `reconcile-external` | ledger ASSET vs. **independent** chain source | 15 min |
| `proof-of-reserves` | liability Merkle tree + address control attestation | daily |
| `outbox` | signed tenant webhooks (at-least-once) | continuous |

Every job idempotent, keyed on `(chain, txHash, index)` or `intentId`.

## 9. Finality policy (per chain)

**Finality is a money decision, not a config detail** — you credit at finality,
so getting it wrong means crediting funds that later vanish.

| Chain | Rule | Note |
| ----- | ---- | ---- |
| Polygon | deep confirmations | history of deep reorgs |
| BSC | `finalized` tag (fast finality) | reorgs observed pre-finality |
| Arbitrum, Base | N L2 confirmations | true finality is L1 settlement; **sequencer risk is real** — document it |
| Tron | solidified block (~19 SR confirmations) | |
| BTC, LTC | 2–6 confirmations, value-scaled | RBF-aware |
| XRP | validated ledger | **deterministic — never reorgs** |

High-value deposits scale confirmations up. Configurable per chain, per tenant.

## 10. Key management in detail

See ADR 0007. Build order: `Signer` port → HSM-guarded capped hot wallet (real
volume) → in-house TSS on testnet → **external cryptographic audit** → cutover.

- **DKG once per key domain**, not per address; BIP32 non-hardened derivation +
  additive key-tweak for unlimited addresses.
- **Per-tenant key domains** (client-asset segregation, ADR 0008), tiered
  hot 2-of-3 / warm 3-of-5 / cold 4-of-7.
- **Proactive share refresh** on schedule — rotates shares without changing
  addresses, defeating a slow multi-month intruder.
- **Node recovery** by re-sharing from the remaining quorum; never reconstruct.
- **Cold DR**: geographically distributed share backup, break-glass gated by
  time-lock + multi-party.
- Ceremony records + HSM attestations are **licence artifacts** — treat them as
  deliverables, not ops trivia.

## 11. Ledger

See [ADR 0010](docs/adr/0010-ledger-solvency-invariant.md) for the account
taxonomy, posting flows, and the solvency invariant. Engine-side notes:

- `packages/ledger` is **pure and property-tested**: postings sum to zero for
  all generated inputs; the invariant survives all event orderings, reorgs, and
  replays.
- Postings and the materialized balance update in **one DB transaction**.
- Drift → **circuit breaker**: freeze withdrawals, page a human. Never
  self-heal a solvency mismatch automatically.

## 12. Deposit attribution & the pool lifecycle

See [ADR 0009](docs/adr/0009-deposit-attribution.md).

```
AVAILABLE → RESERVED → IN_USE → COOLING → AVAILABLE (still holding its balance)
```

- **Exclusive assignment** — one invoice per address at a time. That is what
  makes attribution trivial; no amount-matching needed.
- **Cool-off releases at deposit finality AND payment-window-closed + grace**,
  whichever is later — **not** at sweep. The grace window exists for **late
  payments**: an expired invoice's address, reassigned too eagerly, would
  mis-attribute a late deposit to the next invoice. egofi's existing
  `AmountReservation.cooldownUntil` (`COOLDOWN_MULTIPLIER = 2`) already encodes
  exactly this rule.
- **No `SWEPT` state.** Addresses hold balance while `AVAILABLE` and are reused.
- Atomic claim via `SELECT … FOR UPDATE SKIP LOCKED`.
- Attribution is **per-transaction** on `(chain, txHash, index)` — never per
  address balance. A reused address accumulating many deposits is correct.
- Pool sized so cool-off never starves checkout, while keeping payout gathers
  cheap (§6.3).
- **XRP uses `SharedAccountTagStrategy`** — never pooled addresses.

## 13. Data model (Prisma sketch)

```
Tenant            id, name, status, feeSchedule, jurisdiction, apiKeys[]
Account           id, tenantId, externalRef, status            // a tenant's merchant
LedgerAccount     id, tenantId, type(LIABILITY|ASSET|REVENUE|EXPENSE), key, asset
JournalEntry      id, idempotencyKey UNIQUE, kind, occurredAt
Posting           id, journalEntryId, ledgerAccountId, asset, amount(Decimal 36,18), direction
Balance           ledgerAccountId, asset, amount, version       // optimistic concurrency
PoolAddress       id, tenantId, chain, derivationPath, address, state, cooldownUntil,
                  currentAssignmentId, balanceBaseUnits,
                  gatherStrategy(FORWARDER|EIP7702|EOA_FUND_TRANSFER)   // ADR 0011 — set at mint, dispatch key
                  @@unique([chain, address]) @@index([tenantId, chain, state])
GatherConfig      id, chain, tenantId?, activeStrategy, updatedBy, approvedBy, effectiveAt  // toggle, dual-control
DepositTarget     id, accountId, chain, address, destinationTag?, expiresAt
Deposit           id, accountId, chain, txHash, outputIndex, asset, amount, state,
                  kytScore, creditedJournalEntryId
                  @@unique([chain, txHash, outputIndex])        // idempotency
Withdrawal        id, accountId, asset, amount, destination, state, policyDecision,
                  approvals[], authorizationTokenId, txHash, idempotencyKey UNIQUE
Allowlist         id, accountId, chain, address, addedAt, usableAt   // cool-down
PolicyVersion     id, tenantId?, document(Json), effectiveAt, createdBy, approvedBy
AuthorizationToken id, intentId, sighash, payload(Json), signature, expiresAt
KeyDomain         id, tenantId, tier(hot|warm|cold), quorum, publicKey, dkgCeremonyRef
SigningSession    id, intentId, domainId, nodesParticipated[], state
ComplianceCase    id, subjectType, subjectId, reason, state, filedAt
ReconRun          id, kind(internal|external), asset, ledgerTotal, chainTotal, drift, state
OutboxEvent       id, tenantId, type, payload, status, attempts, nextAttempt
AuditLog          id, actorId, action, targetType, targetId, before, after, ip
```

Every tenant-scoped table carries `tenantId` and a **row-level-security policy**
— the same boot-time check egofi already enforces (a table with `tenantId` and
no policy fails startup).

## 14. Compliance & regulatory

Licence shape and entity structure: [ADR 0008](docs/adr/0008-licensed-custodian-entity.md).

- **KYT both directions.** Deposits are **unilateral** — anyone can send us
  sanctioned funds and we are then holding them. Screen on detection; high risk
  → post to `compliance_suspense`, **do not credit**, escalate. Returning funds
  to source is a legal question, not an obvious kindness. Runbook required.
- **Sanctions screening** on tenants, accounts, and every counterparty address.
- **Travel Rule** — IVMS101 originator/beneficiary exchange for VASP-to-VASP
  transfers above threshold.
- **Transaction monitoring** + SAR/STR filing to the NFIU; case management in
  the console.
- **Proof of reserves** — per-asset liabilities + address-control attestation +
  Merkle inclusion proofs (§11, ADR 0010).
- **Pluggable per jurisdiction.** The engine will serve tenants under different
  regimes; Nigeria's rules must not be hardcoded into the core.
- **Record retention** per licence conditions; `AuditLog` is the trail.

## 15. Monetization

Two planes (ADR 0010), never conflated:

**Engine → tenants (the infrastructure business):**

| Line | Basis |
| ---- | ----- |
| AUC fee | bps/yr on assets under custody |
| Per-transaction | per deposit + per withdrawal processed |
| Per-active-address / per-wallet | infra-aligned |
| Platform subscription | tiered by volume/features (cold storage, insurance, PoR, compliance tooling) |
| Network-fee markup | on withdrawals |
| Treasury yield | **licence-gated, disclosed, segregated — NOT a launch assumption** |

**egofi → its merchants (the PSP business):** 0.5% per confirmed deposit +
withdrawal fees + FX/settlement spread.

egofi pays the engine at **internal cost**; external tenants pay **market rate**.
The custodian entity is where the durable margin lives, because it owns both the
licence and the key technology.

## 16. Tenant API surface

REST + signed webhooks. Versioned. Per-tenant auth with **scoped keys**
(`read` / `move-funds` / `approve`), request signing + replay protection, strict
idempotency on every mutation — reusing egofi's existing IPN/outbox/idempotency
conventions so egofi and the next tenant integrate identically.

```
POST /v1/accounts                          → create sub-account
GET  /v1/accounts/{id}/balance             → per-asset available / pending

POST /v1/accounts/{id}/deposit-addresses   {chain, asset, expiresAt?}
     → { address } | { address, destinationTag }     # pool managed internally

POST /v1/accounts/{id}/withdrawals         {asset, amount, destination, idempotencyKey}
     → PENDING_APPROVAL | AUTHORIZED | BROADCAST | CONFIRMED | REJECTED
POST /v1/withdrawals/{id}/approve          # separate credential — dual control

POST /v1/accounts/{id}/allowlist           {address, chain}   # cool-down applies
POST /v1/transfers                         {from, to, asset, amount}   # book transfer, instant, free

GET  /v1/statements        GET /v1/proof-of-reserves

# webhooks (HMAC-signed, at-least-once, idempotent, via transactional outbox)
deposit.detected · deposit.confirmed · deposit.reorged
withdrawal.authorized · withdrawal.broadcast · withdrawal.confirmed · withdrawal.rejected
address.assigned · compliance.hold
```

**The API never moves money.** It writes intents that the policy engine
authorizes, the ledger records, and the MPC signs — with the solvency invariant
underneath all of it.

### Composed flows

```
INVOICE PAID
  egofi → POST /accounts/{merchant}/deposit-addresses {TRON, USDT}
        ← pooled address (RESERVED)
  customer pays → detection → deposit.detected (merchant_pending)
  finality → credit merchant_available·0.995 + egofi_fee_revenue·0.005
           → deposit.confirmed → egofi marks invoice PAID_CONFIRMED
  COOLING (until final AND window closed + grace) → AVAILABLE
  funds STAY in the pool address — no sweep

MERCHANT PAYOUT  (the only time money moves)
  egofi → POST /accounts/{merchant}/withdrawals {USDT, amount, merchantAddr}
  policy: limits · allowlist+cooldown · velocity · sanctions · solvency
        → dual-approval if over threshold
        → GATHER from the merchant's funded pool addresses (batched on UTXO;
          gas-funded per address on EVM/Tron)
        → MPC signs (nodes independently re-verify) → broadcast
        → withdrawal.confirmed → ledger settles → egofi notifies merchant
```

## 16.5 Environments & the testnet → mainnet cutover

"Switching to live" is **two unrelated problems** that must not be conflated: a
*network* switch (easy, if earned by config discipline) and a *go-live* gate
(deliberately hard, mostly non-code). Get the first right on day one — §17 step 1
— or the second becomes a rewrite.

**The network switch is a config swap — make it one.** Ruthlessly config-driven,
no exceptions:

- **A per-`(chain, env)` chain-config module** — RPC endpoints, chain IDs,
  finality depths, gas params, base reserves. Injected, never imported as
  constants.
- **A token registry keyed by `(chain, env)`** — testnet USDT ≠ mainnet USDT on
  every chain. No contract address is ever a literal in code.
- **No magic constants anywhere** — chain IDs, RPC URLs, indexer endpoints,
  explorer URLs all come from config. A single hardcoded mainnet address is a
  latent incident.
- Follow egofi's existing env discipline (`dev | mock | production`); cixtech
  adds `CHAIN_ENV = testnet | mainnet` on top.

**Separate deployments, never an in-place flag.** testnet and mainnet run as
**distinct deployments — separate key domains, separate databases, separate
`Signer` bindings.** A testnet key must be *structurally incapable* of signing a
mainnet transaction and vice versa (same misbinding-guardrail class as the
`chain_id = 0` rule, §6.5). Going live = **promoting a validated build into a
differently-configured, separately-keyed production environment** — not flipping
an env var in a running system.

**What is NOT a config flip** (these gate live, and no env var switches them):

- **Production keys are a ceremony, not a value** — a witnessed DKG producing
  HSM-sealed shares in a new production domain (ADR 0007), itself a licence
  artifact. The `Signer` abstraction makes this a *binding* change, not a
  rewrite — but it is a controlled event.
- **The external MPC audit gate** (ADR 0007) — no real value before it clears.
- **The licence gate** (ADR 0008) — flawless code still cannot hold third-party
  funds until the DASP licence / ARIP is in place.
- **Behaviors testnet cannot express** — real reorgs (Polygon depth, BSC
  pre-finality), real gas markets, a real KYT/sanctions hit on an inbound
  deposit, real Travel Rule counterparties, L2 sequencer incidents, mempool
  congestion. So finality depths (§9), gas floats, pool sizing, hot-ratio and
  cold-storage posture (§6.4) are **config knobs tuned during the mainnet ramp**,
  not constants baked at build.

**The real "switch" is a staged mainnet ramp, not a boolean:**

1. **Shadow / detection-only on mainnet** — watch real addresses, credit a
   *shadow* ledger, run reconciliation + the solvency invariant, **withdrawals
   disabled**. Exercises real reorgs/gas/KYT at ~zero value at risk.
2. **Capped live value** — real deposits and payouts under tight per-tx/daily
   caps and the fully-online-float posture, watching the circuit breaker.
3. **Scale the caps** as the reconcilers and the volume model prove out.

## 17. Build order (capability-layered, not time-boxed)

Two gates run **in parallel** with all of it, never after: the **DASP licence**
(ARIP as provisional on-ramp) and the **MPC cryptographic audit**.

1. **Ledger core + config spine** — accounts, postings, balances, solvency
   invariant, reconcilers, property-tested; **and** the per-`(chain, env)`
   chain-config module + token registry with a no-magic-constants lint rule
   (§16.5). No keys, no chains. *Prove the accounting; make the network switch a
   config swap from the first commit.*
2. **`Signer` port + one chain end-to-end** — Tron/USDT (egofi's default) on
   testnet: deposit → finality → credit-minus-fee → sweep → withdraw, behind an
   HSM-guarded capped hot wallet.
3. **Pool lifecycle + cool-off + gas station + treasury tiering.**
4. **Policy engine + approvals + circuit breaker** — before any real value.
5. **In-house TSS** on testnet → external audit → cutover from hot wallet.
6. **Chain expansion** — the `GatherStrategy` port + per-address tag +
   **CREATE2 forwarders** as the sole strategy (ADR 0011); EVM set (one adapter,
   four configs) → BTC/LTC (UTXO batching) → XRP (shared account + tags). Adopt
   7702 for gas-abstraction + treasury smart-accounts here; the 7702 *gather*
   strategy is a later, audit-gated addition behind the same port.
7. **Compliance module** — KYT, sanctions, Travel Rule, case management, PoR.
8. **Multi-tenant API + webhooks + billing** → onboard a second tenant beyond
   egofi. *This is the moment it becomes a business rather than a dependency.*

---

## Decisions — resolved

- **Custody, not non-custody.** ADR 0006. 0.5% take at deposit finality.
- **In-house threshold MPC on secp256k1 + HSM**, one curve for all eight chains.
  ADR 0007.
- **Our own custodian licence, in a separate legal entity**; egofi is a tenant.
  ADR 0008.
- **Per-merchant address pools that hold balance**; cool-off releases at deposit
  finality + window grace; **the payout is the only sweep**; XRP is
  shared-account + destination tag. ADR 0009.
- **Double-entry ledger with a continuously enforced solvency invariant** and a
  circuit breaker on drift. ADR 0010.
- **Signer abstraction from day one** so the MPC audit never gates launch.
- **Independent chain source** for reconciliation vs. detection.
- **`GatherStrategy` port** with a forward-only, per-address-tagged toggle;
  **CREATE2 forwarders at launch** (all EVM + Tron), **EIP-7702 as a later,
  audit-gated second strategy**; 7702 adopted now only for gas-abstraction +
  treasury smart-accounts. ADR 0011.

## Decisions — resolved (launch config)

- **Name:** **cixtech**.
- **Separate repo**, owned by the custodian entity (ADR 0008).
- **TSS:** **CMP** family (threshold ECDSA, secp256k1, proactive refresh). ADR 0007.
- **HSM:** **CloudHSM / KMS custom keystore**.
- **Gather:** `GatherStrategy` port; **CREATE2 forwarders at launch**; 7702 later.
  ADR 0011.

## Still open

- **[DECISION]** CMP audit vendor.
- **[DECISION]** KYT provider; Travel Rule network.
- **[DECISION]** EOA fund-then-transfer bootstrap → CREATE2 forwarder cutover:
  at what volume threshold? (Both behind the `GatherStrategy` port — ADR 0011.)
- **[DECISION]** Tron energy: stake vs. rent, and the TRX float that implies.
- **[DECISION]** **Cold storage posture (§6.4).** The float is online by
  construction. Warm-tier pool domain, idle-balance consolidation, both, or
  accept a fully-online float? Drives the licence and insurance conversation.
- **[DECISION]** Pool size per (merchant, chain) — the trade is cool-off
  starvation vs. payout gather cost. Needs volume modelling.
- **[DECISION]** Do non-custodial merchants remain supported on
  `DirectTransferRail`, or does egofi go custody-only?
- **[DECISION]** Regulatory capital + insurance/fidelity bond sizing — counsel.
- **[OPEN]** Treasury-yield line: legally permissible only under licence
  conditions; confirm before modelling it as revenue.
