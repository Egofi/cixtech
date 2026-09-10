# ADR 0017: The engine scope boundary — no merchant, checkout or fiat layer in cixtech

**Status:** Accepted
**Supersedes:** `docs/PRD_CRYPTO_FINANCIAL_OS.md` (withdrawn — see below)

## Context

The build spec opens with the sentence the whole business rests on:

> egofi is the **first tenant**, not the owner. The engine knows nothing about
> invoices, checkouts or merchants — it knows **tenants, accounts, deposits,
> withdrawals, and fees**.

and states it again as non-negotiable principle 7: *"Multi-tenant from line one…
Never let egofi's assumptions leak in."*

A single commit (`92cc8a0`, "full spec build") built the opposite, following
`PRD_CRYPTO_FINANCIAL_OS.md` — a document that recast cixtech as an
"End-to-End Crypto Financial Operating System". It added, inside the custody
engine:

- fiat **payment intents** with a 15-minute price lock, and a hosted pay page
- a browser **checkout modal SDK** (`@cixtech/checkout`) with wallet detection
- a retail **POS** QR + thermal-receipt endpoint
- **fiat off-ramp** rails (NIBSS, PIX, SEPA, ACH, M-Pesa, MoMo)
- customer **refunds**, GAAP/IFRS **GL export** and **ERP sync** (QuickBooks,
  Xero, NetSuite)
- `payment_intent` and `stranded_deposit` tables carrying `merchant_id`,
  `amount_fiat` and `offramp_channel`

Every one of those is a payment-service-provider concern, and every one of them
already exists in egofi (`apps/checkout`, `apps/merchants`, `apps/admin`). The
result was a second, weaker PSP built one layer beneath the real one — and the
PRD never reconciled itself with the build spec it contradicts.

The layer was not merely misplaced. Because it was written against a product
model the engine does not have, it reached for the engine's primitives in ways
the engine's own invariants forbid:

- `/v1/checkout/recovery/claim` was on the **public** auth allow-list, looked a
  deposit up by `(chain, txHash)` — both public on-chain data, with no tenant
  scope — and paid it out to a **caller-supplied address** under a synthetic
  `RECOVERY` merchant, which is not on any allow-list and has no limits. An
  unauthenticated fund-drain path.
- `GET /v1/proof-of-reserves` reported a hardcoded `"105.00%"` coverage, a
  "Merkle root" that was `sha256(tenant:…:Date.now())` with no tree and no
  leaves, and a "signature" that was that hash truncated. Its two balance
  queries aliased `as total` while the code read `.amount`, so it always fell
  through to hardcoded constants and never read the database at all. Proof of
  reserves is a **licence requirement** under ADRs 0008 and 0010; a fabricated
  one is worse than none.
- `POST /v1/checkout/intents/:id/pay` was public, accepted a client-supplied
  `txHash` with no on-chain verification, and triggered an off-ramp whose
  `dispatch()` posted a **real `payoutSettled` journal entry** for fiat no rail
  had been asked to send — writing solvency drift straight into the ledger.
- The FX engine backed a *"guaranteed"* price lock with static constants
  (`BTC: 65000.0`), against principle 8 (no magic constants).
- `LedgerExporter` scoped its trial balance to a tenant with
  `account LIKE '%'||$1||'%' OR account LIKE 'pool_addr:%' OR …` — the `OR` arms
  are unscoped, so every tenant's export included every other tenant's pool and
  treasury balances.

These are not five unlucky bugs. They are what happens when a layer that needs a
merchant, an order and a fiat rail is grafted onto an engine that has no concept
of any of them: it invents the missing halves.

## Decision

**The engine's vocabulary is tenants, accounts, deposits, withdrawals, fees and
policy. Nothing above that line lives in this repo.**

Concretely:

1. The checkout, POS, FX, off-ramp, refund, GL-export and ERP-sync surfaces are
   removed from cixtech, along with their tables (`payment_intent`,
   `stranded_deposit`, `refund`) and packages (`@cixtech/checkout`,
   `@cixtech/accounting`, `chains/{fx,offramp,refund}`).
2. `PRD_CRYPTO_FINANCIAL_OS.md` is withdrawn. Where a PRD and the build spec
   disagree, the build spec wins; a PRD that intends to change the engine's
   scope must arrive as an ADR that supersedes this one, not as a feature list.
3. Those capabilities belong to **egofi**, which already implements them against
   its own merchant model, and which reaches the engine the way any other tenant
   does — through `/v1` with a scoped key.
4. A tenant-facing surface is only in scope if it can be described without the
   words *merchant*, *invoice*, *order*, *checkout* or *fiat*. Sub-accounts are
   how a tenant models its own merchants; that mapping is the tenant's, and the
   engine stores it as an opaque `externalRef` and nothing more.

### What this deliberately leaves unbuilt

Removing the fabricated implementations does not conjure the real ones. Two
spec §16 routes are now honestly absent rather than dishonestly present:

- **`GET /v1/proof-of-reserves`** — a real one needs a signed, tenant-scoped
  Merkle commitment over per-asset liabilities with per-account inclusion
  proofs, reconciled against an independent chain source (§2's independent-source
  rule). It is a licence deliverable and gets its own ADR.
- **`GET /v1/statements`** — the engine legitimately owes tenants a statement.
  It is a period-scoped, per-asset ledger extract, not a QuickBooks CSV.

## Consequences

- The unauthenticated payout path, the fabricated PoR, the unverified `/pay`
  credit and the cross-tenant trial balance are all gone with the layer that
  carried them.
- cixtech's public API returns to the §16 surface. Any tenant — egofi or the
  next one — integrates against exactly the same routes, which is the thing that
  makes the engine sellable at all.
- egofi keeps ownership of the customer experience. If it wants stranded-deposit
  recovery or a POS flow, it builds them where a merchant and an order exist,
  calling `/v1` for the custody half.
- `@cixtech/ai` remains in the repo pending its own scope decision. It arrived
  with the same PRD and is not in the build spec; its `stranded_deposit`
  anomaly check was dropped with that table.
