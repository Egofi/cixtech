> [!WARNING]
> **Withdrawn — this document describes egofi, not cixtech.**
>
> It recasts the custody engine as a merchant-facing payment product, which
> contradicts the build spec's founding separation ("the engine knows nothing
> about invoices, checkouts or merchants") and non-negotiable principle 7. The
> code written from it was removed; see
> [ADR 0017](adr/0017-engine-scope-boundary.md).
>
> The thinking here is not wrong — it is filed in the wrong repo. Its home is
> egofi, which owns merchants, orders and fiat. Kept for that history only; do
> not build from it here.

---

# User Stories & Epic Backlog
## Project Name: CIXTech End-to-End Crypto Financial Operating System (OS)
**Document Version:** 1.0  
**Date:** August 5, 2026  
**Status:** Engineering Ready  

---

## Epic Overview Index

```mermaid
graph TD
    Epic1[EPIC 1: Core Engine Closure & Infrastructure] --> Epic2[EPIC 2: Smart Multi-Chain Checkout & Gas Engine]
    Epic1 --> Epic3[EPIC 3: FX Auto-Conversion & Mobile Money Off-Ramping]
    Epic1 --> Epic4[EPIC 4: Double-Entry Reconciliation & ERP Connectors]
    Epic3 --> Epic5[EPIC 5: Automated Sub-Minute Refunds & Subscriptions]
    Epic1 --> Epic6[EPIC 6: Real-Time KYT, Travel Rule & Solvency (PoR)]
    Epic2 --> Epic7[EPIC 7: Merchant Analytics, POS & E-Commerce Plugins]
    Epic4 --> Epic8[EPIC 8: Enterprise Developer Platform & Webhook Queues]
```

---

## EPIC 1: Core Engine Closure & Infrastructure Fixes

### Story US-ENG-01: EVM ERC-20 Gas Station Integration
* **Pain Point Traceability:** Engine Failure Mode (`.whereweare` Finding 1)
* **Priority:** P0 (Must Have) | **Estimate:** 5 Story Points  
* **As a** CIXTech System Broadcaster,  
* **I want** the EVM payout worker to verify gas balances on pool addresses and trigger native gas funding via `GasStation` prior to signing ERC-20 transfers,  
* **So that** mainnet EVM ERC-20 payout and gather transactions never fail due to `INSUFFICIENT_NATIVE_GAS`.

#### Acceptance Criteria (Gherkin format):
- **Given** an EVM pool address holding 1,000 USDC and 0 ETH native balance,
- **When** a payout or gather transaction is queued,
- **Then** `evm-broadcaster.ts` calls `GasStation.ensureGasBalance(poolAddress, chainId)`,
- **And** the Gas Station signs and broadcasts a native ETH transfer to `poolAddress`,
- **And** once confirmed, the 1,000 USDC payout transaction is signed and broadcast cleanly.

---

### Story US-ENG-02: GatherStrategy Address Tagging
* **Pain Point Traceability:** Engine Failure Mode (`.whereweare` Finding 2, ADR 0011)
* **Priority:** P0 (Must Have) | **Estimate:** 3 Story Points  
* **As a** Custody Protocol Engineer,  
* **I want** every minted deposit pool address to be assigned a explicit `GatherStrategy` tag in the database,  
* **So that** funds accumulated in pool addresses are never stranded without a defined gather strategy.

#### Acceptance Criteria:
- **Given** the database schema with a new `gather_strategy` column on the `pool` table,
- **When** `engine.pool.assign()` or minting is invoked,
- **Then** the record must be saved with a strategy tag (e.g. `EOA_FUND_TRANSFER`),
- **And** attempting to mint an address without a strategy tag throws an `InvalidPoolConfigurationError`.

---

### Story US-ENG-03: Pool Lifecycle Worker (`COOLED` $\rightarrow$ `AVAILABLE`)
* **Pain Point Traceability:** Engine Failure Mode (`.whereweare` Finding 3)
* **Priority:** P0 (Must Have) | **Estimate:** 5 Story Points  
* **As a** CIXTech Treasury Manager,  
* **I want** deposit pool addresses to cycle from `IN_USE` to `COOLED` upon sweep finality and back to `AVAILABLE` via a background worker,  
* **So that** the total address pool remains bounded and gather gas costs are minimized.

#### Acceptance Criteria:
- **Given** a pool address in `IN_USE` state whose gather transaction has reached `FINALIZED` block status,
- **When** the pool lifecycle background worker runs (every 60 seconds),
- **Then** it invokes `cool(address)` transitioning the address state to `COOLED`,
- **And** after a mandatory 5-minute cooling window, it calls `releaseCooled(address)`, returning the state to `AVAILABLE`.

---

### Story US-ENG-04: Dual Control Withdrawal Approvals & Scoped API Keys
* **Pain Point Traceability:** Engine Failure Mode (`.whereweare` Finding 4, Spec §16)
* **Priority:** P0 (Must Have) | **Estimate:** 5 Story Points  
* **As a** Merchant Security Officer,  
* **I want** high-value withdrawals requiring policy approval to be actionable via `POST /v1/withdrawals/{id}/approve` using a dedicated `scope: approve` API key,  
* **So that** no single API key can unilaterally create and execute high-value fund movements.

#### Acceptance Criteria:
- **Given** a withdrawal request that triggers `REQUIRE_APPROVAL` (HTTP 202 status),
- **When** an API call is made to `POST /v1/withdrawals/{id}/approve`,
- **Then** the request is authorized ONLY if the requesting API key possesses the `approve` scope,
- **And** upon valid authorization, the withdrawal transitions to `QUEUED_FOR_BROADCAST`.

---

## EPIC 2: Smart Multi-Chain Checkout & Paymaster Gas Engine

### Story US-CHK-01: Smart Auto-Chain Detection Checkout Modal
* **Pain Point Traceability:** PP 4, PP 5, PP 8 (Complex Wallets, Chain Confusion, Abandonment)
* **Priority:** P0 (Must Have) | **Estimate:** 8 Story Points  
* **As an** End Customer purchasing goods online,  
* **I want** the payment modal to automatically detect my wallet's network and select the fastest, lowest-fee chain,  
* **So that** I do not have to manually configure networks or guess which chain to use.

#### Acceptance Criteria:
- **Given** a merchant checkout widget rendered on an e-commerce site,
- **When** the customer connects their wallet (MetaMask/WalletConnect/Phantom/TronLink),
- **Then** the widget inspects the active network and available stablecoin balances,
- **And** presents a 1-click payment confirmation showing exact token and fiat equivalent amounts.

---

### Story US-CHK-02: Stranded Token Recovery Portal
* **Pain Point Traceability:** PP 5 (Chain Confusion & Wrong-Network Funds)
* **Priority:** P1 (Should Have) | **Estimate:** 5 Story Points  
* **As a** Customer who accidentally sent USDT on Tron to an EVM pool address,  
* **I want** a self-service recovery page to claim and redirect my funds,  
* **So that** my funds are not lost or stuck in customer support queues.

#### Acceptance Criteria:
- **Given** a multi-chain ingestor detecting an unallocated deposit on a pool address,
- **When** the customer visits `https://checkout.cixtech.com/recovery/{txHash}`,
- **Then** the system verifies ownership via a cryptographically signed wallet message,
- **And** sweeps the funds back to the user's specified destination wallet minus network gas.

---

## EPIC 3: Auto-Conversion, FX Protection & Mobile Money Off-Ramping

### Story US-FX-01: 15-Minute Guaranteed Exchange Rate Lock
* **Pain Point Traceability:** PP 1 (Volatility, Settlement & Hidden Spreads)
* **Priority:** P0 (Must Have) | **Estimate:** 8 Story Points  
* **As a** Merchant selling digital goods in USD,  
* **I want** the exchange rate locked for 15 minutes during customer checkout,  
* **So that** market volatility does not erode my sales revenue or margins.

#### Acceptance Criteria:
- **Given** a merchant generating a $100 payment link,
- **When** the checkout page is opened by the customer,
- **Then** the API calculates the required crypto amount (e.g. 0.0016 BTC) and freezes the rate for 900 seconds,
- **And** if the deposit is detected within 900 seconds, the merchant is credited with exactly $100.00 in stablecoins/fiat.

---

### Story US-FX-02: Instant Local Fiat & Mobile Money Off-Ramping
* **Pain Point Traceability:** PP 3, PP 15 (Slow Settlement, Cross-Border FX, Emerging Markets)
* **Priority:** P0 (Must Have) | **Estimate:** 8 Story Points  
* **As a** Merchant operating in Nigeria or Kenya,  
* **I want** crypto payments automatically settled into my local bank account (NGN) or M-Pesa (KES),  
* **So that** I have immediate liquidity to pay local suppliers without managing crypto wallets.

#### Acceptance Criteria:
- **Given** a merchant setting their settlement preference to `AUTO_OFFRAMP_LOCAL_CURRENCY`,
- **When** a customer payment completes on-chain,
- **Then** CIXTech FX Engine routes the stablecoins to a licensed off-ramp provider,
- **And** dispatches a local NIBSS bank transfer (NGN) or M-Pesa push (KES) within `< 5 minutes`.

---

## EPIC 4: Double-Entry Accounting, ERP Sync & Tax Reporting

### Story US-ACC-01: `@cixtech/ledger` Automated Invoice Matching
* **Pain Point Traceability:** PP 2, PP 7 (Accounting, Reconciliation & Auditing)
* **Priority:** P0 (Must Have) | **Estimate:** 5 Story Points  
* **As a** Merchant Financial Controller,  
* **I want** every crypto deposit automatically linked to its corresponding invoice ID in a double-entry ledger format,  
* **So that** our accounting books are balanced with zero manual spreadsheet reconciliation.

#### Acceptance Criteria:
- **Given** a payment of $250.00 USDC received for Invoice `INV-9042`,
- **When** the ingestor processes the deposit,
- **Then** `@cixtech/ledger` posts balanced journal entries (`DEBIT Asset`, `CREDIT Unsettled Liability`),
- **And** tags the journal entry with `invoiceId: INV-9042` and `transactionHash`.

---

### Story US-ACC-02: Turnkey QuickBooks & Xero Sync
* **Pain Point Traceability:** PP 2, PP 10, PP 17 (ERP Integration & Tax Export)
* **Priority:** P1 (Should Have) | **Estimate:** 8 Story Points  
* **As an** Accounting Specialist,  
* **I want** CIXTech to automatically sync settled payments, processing fees, and payouts to QuickBooks Online and Xero,  
* **So that** our monthly financial closing takes minutes instead of days.

#### Acceptance Criteria:
- **Given** an active OAuth connection to QuickBooks Online,
- **When** daily payments and fee sweeps settle,
- **Then** CIXTech pushes corresponding Sales Receipts and Expense entries to QBO,
- **And** sets status to `RECONCILED`.

---

## EPIC 5: Sub-Minute One-Click Refunds & Subscriptions

### Story US-RFD-01: Sub-Minute Customer Self-Service Refund Flow
* **Pain Point Traceability:** PP 6 (Terrible Refunds & Irreversibility)
* **Priority:** P0 (Must Have) | **Estimate:** 5 Story Points  
* **As a** Merchant Customer Support Agent,  
* **I want** to issue a refund link to a customer with one click in the Admin Console,  
* **So that** refunds are processed smoothly without asking for manual wallet addresses.

#### Acceptance Criteria:
- **Given** an order marked as `COMPLETED`,
- **When** the merchant clicks "Issue Refund" in Admin Portal,
- **Then** an email with a secure claim link `https://pay.cixtech.com/refund/{token}` is sent to the customer,
- **When** the customer opens the link and submits their wallet address,
- **Then** CIXTech MPC Signer dispatches the refund transaction within `< 30 seconds`.

---

### Story US-RFD-02: Recurring Pull-Payment Subscriptions
* **Pain Point Traceability:** PP 13 (Subscription Payments & Billing)
* **Priority:** P1 (Should Have) | **Estimate:** 8 Story Points  
* **As a** SaaS Business Owner,  
* **I want** customers to authorize recurring monthly stablecoin payments,  
* **So that** subscription billing happens automatically without monthly manual customer action.

#### Acceptance Criteria:
- **Given** a customer subscribing to a $49/month SaaS plan,
- **When** they sign a smart contract pull-payment authorization (EIP-7582 / Vault Allowance),
- **Then** CIXTech automated cron engine pulls $49 USDC on the 1st of every month,
- **And** emits `subscription.renewed` webhooks upon success.

---

## EPIC 6: Automated KYT Compliance, Travel Rule & Solvency (PoR)

### Story US-CMP-01: Real-Time Pre-Credit KYT Address Screening
* **Pain Point Traceability:** PP 11, PP 12 (Fraud Detection & Compliance Burden)
* **Priority:** P0 (Must Have) | **Estimate:** 8 Story Points  
* **As a** Chief Compliance Officer,  
* **I want** all incoming deposits screened against Chainalysis/TRM APIs before funds are credited to merchant balances,  
* **So that** dirty, stolen, or sanctioned funds never touch our primary ledger or bank partners.

#### Acceptance Criteria:
- **Given** an incoming blockchain deposit event detected by ingestor,
- **When** `DepositScreener.screen(senderAddress)` returns `RISK_LEVEL_CRITICAL` (e.g. Sanctioned/Mixer),
- **Then** the transaction is posted to `ACCOUNT_TYPE_QUARANTINE`,
- **And** the merchant balance is NOT credited, triggering an alert in Compliance Console.

---

### Story US-CMP-02: Cryptographic Proof of Reserves (PoR) Verifier
* **Pain Point Traceability:** PP 25 (`.whereweare` & ADR 0010 Solvency Invariant)
* **Priority:** P1 (Should Have) | **Estimate:** 5 Story Points  
* **As a** Regulated Custody Auditor,  
* **I want** to query `GET /v1/proof-of-reserves` to verify on-chain balances match double-entry liabilities,  
* **So that** we have real-time proof of platform solvency.

#### Acceptance Criteria:
- **Given** system state with total customer liabilities of $5,000,000 USDC across ledger accounts,
- **When** `GET /v1/proof-of-reserves` is queried,
- **Then** it returns an audited Merkle tree root and on-chain signature proof confirming $\sum \text{Assets} \ge \$5,000,000$.

---

## EPIC 7: Merchant Analytics, POS Terminal & E-Commerce Plugins

### Story US-POS-01: Point-of-Sale Terminal Dynamic QR Generator
* **Pain Point Traceability:** PP 16 (POS & Retail Integration)
* **Priority:** P1 (Should Have) | **Estimate:** 5 Story Points  
* **As a** Retail Store Cashier,  
* **I want** to generate a dynamic payment QR code on a mobile/tablet POS app that updates instantly when paid,  
* **So that** I can accept crypto payments in-person at checkout counters.

#### Acceptance Criteria:
- **Given** a cashier entering an order total of $15.50 on POS app,
- **When** "Generate QR" is pressed,
- **Then** a dynamic QR code containing network routing and exact amount is rendered,
- **And** as soon as block confirmation is received, POS emits a success chime and option to print thermal receipt.

---

## EPIC 8: Enterprise Developer Platform & Webhook Queues

### Story US-DEV-01: Idempotency & High-Reliability Webhook Queue
* **Pain Point Traceability:** PP 20 (Developer Experience & Integration Reliability)
* **Priority:** P0 (Must Have) | **Estimate:** 5 Story Points  
* **As a** Lead Software Integrator,  
* **I want** CIXTech API requests to support `Idempotency-Key` headers and webhooks to deliver with exponential retries,  
* **So that** network glitches never result in double payments or missed order fulfillments.

#### Acceptance Criteria:
- **Given** an API request sent with `Idempotency-Key: 8f9b1c-22a`,
- **When** the identical request is retried within 24 hours,
- **Then** the API returns the cached HTTP response without re-executing funds movement,
- **And** failed webhook deliveries are automatically retried at intervals (15s, 1m, 5m, 1h, 24h) with HMAC signature verification (`X-CIXTech-Signature`).

---

## Summary Backlog Estimation & Priority Matrix

| Story ID | Epic Title | Priority | Story Points | Target Sprint |
| :--- | :--- | :--- | :--- | :--- |
| **US-ENG-01** | Core Engine: EVM Gas Station Wiring | P0 | 5 | Sprint 1 |
| **US-ENG-02** | Core Engine: GatherStrategy Tagging | P0 | 3 | Sprint 1 |
| **US-ENG-03** | Core Engine: Pool Lifecycle Worker | P0 | 5 | Sprint 1 |
| **US-ENG-04** | Core Engine: Approval Route & Scoped Keys | P0 | 5 | Sprint 2 |
| **US-CHK-01** | Checkout: Smart Auto-Chain Modal | P0 | 8 | Sprint 2 |
| **US-CHK-02** | Checkout: Stranded Token Recovery | P1 | 5 | Sprint 3 |
| **US-FX-01** | FX: 15-Min Guaranteed Rate Lock | P0 | 8 | Sprint 2 |
| **US-FX-02** | FX: Mobile Money & Fiat Off-Ramping | P0 | 8 | Sprint 3 |
| **US-ACC-01** | Accounting: `@cixtech/ledger` Invoice Match | P0 | 5 | Sprint 3 |
| **US-ACC-02** | Accounting: QuickBooks & Xero Sync | P1 | 8 | Sprint 4 |
| **US-RFD-01** | Refunds: Sub-Minute Customer Self-Service | P0 | 5 | Sprint 3 |
| **US-RFD-02** | Subscriptions: Recurring Pull Payments | P1 | 8 | Sprint 4 |
| **US-CMP-01** | Compliance: Real-Time KYT Screening | P0 | 8 | Sprint 4 |
| **US-CMP-02** | Compliance: Proof of Reserves Verifier | P1 | 5 | Sprint 4 |
| **US-POS-01** | POS: Dynamic QR & Receipt Generator | P1 | 5 | Sprint 5 |
| **US-DEV-01** | Developer: Idempotency & Webhook Queue | P0 | 5 | Sprint 1 |
| **TOTAL** | **8 Epics Backlog** | **P0/P1** | **99 Points** | **Sprints 1–5** |
