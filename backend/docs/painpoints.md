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

**The biggest pain points for merchants using crypto payment gateways center on operational friction, financial risks, poor user experience (for both merchants and customers), compliance burdens, and reliability issues.** These emerge consistently across reviews, forums (e.g., Reddit, Trustpilot), articles, merchant surveys, and discussions on X. While crypto offers benefits like lower decline rates, no traditional chargebacks, and global reach, gateways often fail to deliver seamless, predictable experiences comparable to fiat systems like Stripe or traditional processors.

Here’s a breakdown of the most reported issues, drawn from deep research into merchant feedback, comparisons, and analyses:

### 1. **Volatility, Settlement, and Hidden/Effective Costs**
   - Merchants hate price swings between invoice generation and confirmation/settlement, which can erode margins. Many gateways offer auto-conversion to fiat or stablecoins, but delays expose merchants to risk, and **hidden spreads** (0.5–2.5%+ above mid-market) plus withdrawal/payout fees stack up, often pushing effective costs well above advertised "low" fees (e.g., 1% headline becoming 1.5–4%+ all-in).
   - Reconciliation and accounting headaches: Transactions don't always match cleanly due to network delays, partial payments, or multi-coin support. Over half of finance pros in crypto-accepting businesses report issues in the first year.
   - **Merchant reports**: Complaints about unexpected fees, conversion losses, and manual fiat off-ramps. Self-custody options reduce counterparty risk but shift treasury/liquidity management burdens.

### 2. **Complex or Poor Checkout UX Leading to Abandoned Carts**
   - Customers (even crypto-native ones) abandon at high rates (e.g., 76% in recent data) due to confusion over gas fees, wallet setup, wrong networks/chains, transaction errors, and settlement delays. Mobile abandonment is worse.
   - Gateways often fail to make flows "obvious, predictable, and fast." Issues include unclear instructions, missing feedback, and analysis paralysis from too many coin options.
   - **For merchants**: This translates to lost sales. Integrations (especially on platforms like Shopify) add extra fees (0.5–2%), limited approved providers, and multi-account management.

### 3. **Refunds, Disputes, and Irreversibility**
   - Crypto transactions are irreversible, so refunds require manual sends (with network fees and volatility exposure). Gateways don't support easy one-click refunds like cards, leading to 2–3x longer support tickets and customer friction.
   - No chargebacks is a pro for fraud protection but leaves merchants handling policy/refund abuse, wrong-network deposits, under/overpayments, and disputes manually. Partial payments and edge cases (e.g., expired invoices) create operational nightmares.
   - **Feedback**: Merchants describe refund processes as "purgatory" or error-prone; customers lose funds or face delays.

### 4. **Compliance, KYC/KYT, and Regulatory Uncertainty**
   - Heavy KYC/KYB for merchants (business verification, docs) before meaningful volume or fiat withdrawals. Sudden account freezes, holds, or deplatforming due to compliance reviews.
   - AML/KYT often happens post-transaction (on-chain risk screening gaps), exposing merchants to dirty funds risks, banking partner issues, or frozen settlements. Travel Rule and jurisdiction-specific rules (e.g., MiCA) add complexity.
   - **Merchant pain**: Onboarding delays (days/weeks), manual reviews, and fear of banking disruptions. Some gateways require extensive paperwork; others have opaque processes.

### 5. **Reliability, Support, and Counterparty Risks**
   - Delayed confirmations (network congestion), RPC failures, stuck transactions, and poor webhook reconciliation. Custodial gateways introduce solvency/counterparty risk (e.g., past custodian collapses).
   - **Customer support complaints** dominate reviews for providers like CoinPayments, NOWPayments, BitPay, and Coinbase Commerce: unresponsive tickets, funds held hostage (e.g., high "gas fees" for refunds/withdrawals far above actual costs), unresolved issues, and accusations of scams or theft. Trustpilot and Reddit are full of examples—e.g., underpayments leading to lost funds, delayed payouts, or account blocks after high volume.
   - Integration challenges: API changes without notice, idempotency issues, partial payment handling, and platform-specific hurdles (e.g., Shopify).

### 6. **Limited Adoption, Fragmentation, and Accounting/Integration Friction**
   - Merchants don't want to overhaul accounting, staff training, or dashboards. Crypto requires new workflows for multi-chain support, tax reporting, and reconciliation.
   - Fragmented ecosystem (wallets, chains, tokens) makes it hard to support customer preferences without complexity. Low overall merchant acceptance (~10% in some surveys) creates a network effect barrier.
   - B2B-specific: Liquidity for large trades, cross-border regs, and infrastructure uptime.

**Overall Sentiment**: Many merchants view crypto gateways as "still in beta" for mainstream use—great for niche/tech-savvy audiences or chargeback-heavy businesses, but not a drop-in replacement for fiat due to these frictions. Self-hosted options (e.g., BTCPay Server) or advanced gateways addressing auto-conversion, clear UX, and compliance reduce some pain, but no solution fully eliminates them yet. Positive notes include faster settlements in some cases and global reach, but complaints about support and hidden costs are pervasive.

Merchants recommend thorough testing (sandbox, edge cases), prioritizing fiat auto-settlement, transparent fee structures, strong KYT, and providers with proven reliability over coin breadth. For deeper dives, check Trustpilot/Reddit threads for specific gateways or reports from PYMNTS/CoinLaw. Solutions are evolving (e.g., better stablecoin UX, Lightning support), but these remain core unsolved or poorly addressed gaps.


Most crypto payment gateways solve the problem of **accepting crypto**, but not the problems merchants actually care about: **getting paid, reconciling payments, managing risk, and running a business.**

Here are the biggest pain points that many crypto payment gateways still fail to address.

### 1. Price Volatility (The #1 Problem)

A customer pays 0.01 BTC today, and by tomorrow it's worth 8% less.

Merchants don't want to speculate on crypto prices—they want predictable revenue.

**What's missing**

* Instant conversion to stablecoins or fiat
* Automatic hedging
* Guaranteed settlement value

---

### 2. Poor Accounting & Reconciliation

Many gateways only show transactions.

Businesses need:

* Invoice matching
* Customer matching
* Tax reports
* Export to QuickBooks/Xero
* Revenue reports

Finance teams spend hours manually reconciling crypto payments.

---

### 3. Slow Settlement

Receiving crypto instantly doesn't mean businesses can use it instantly.

Pain points:

* Waiting for confirmations
* Delayed fiat withdrawals
* Bank transfer delays

Merchants want same-day liquidity.

---

### 4. Complex Wallet Management

Many businesses don't understand:

* Wallets
* Seed phrases
* Networks
* Gas fees

They want something that behaves like Stripe or Paystack.

---

### 5. Chain Confusion

Customers send:

* USDT on Tron instead of Ethereum
* USDC on Base
* Tokens on unsupported chains

Funds become difficult or impossible to recover.

Merchants want one payment link that intelligently accepts multiple chains.

---

### 6. Refunds are Terrible

Traditional payments:

* Click Refund

Crypto:

* Ask customer for wallet
* Verify chain
* Verify token
* Send manually

Mistakes are irreversible.

---

### 7. Chargeback Alternative

Crypto has no chargebacks.

That's good...

Until:

* Customer claims they never received goods
* Merchant accidentally sends wrong item

There's little built-in dispute resolution.

---

### 8. Poor Checkout Experience

Many gateways:

* Show long wallet addresses
* Ask users to copy/paste
* Require QR scanning

Customers abandon payments.

Modern checkout should feel like:

* Apple Pay
* Google Pay
* One-click wallet connection

---

### 9. Multi-Currency Management

Businesses accept:

* BTC
* ETH
* USDT
* USDC
* SOL

Now they have dozens of balances.

They want automatic treasury management.

---

### 10. Tax Reporting

Governments increasingly require crypto reporting.

Businesses need:

* Cost basis
* Gains/losses
* VAT/GST calculations
* Tax exports

Few gateways handle this well.

---

### 11. Fraud Detection

Traditional processors have years of fraud models.

Crypto gateways often don't detect:

* Sanctioned wallets
* Stolen funds
* Mixer-related addresses
* High-risk wallets

---

### 12. Compliance Burden

Merchants struggle with:

* KYC
* AML
* Travel Rule
* OFAC screening

Many gateways leave compliance entirely to the merchant.

---

### 13. Subscription Payments

Recurring crypto payments remain cumbersome.

Businesses want:

* Monthly billing
* Auto-renewals
* Payment retries
* Failed payment notifications

---

### 14. Customer Identity

Wallet addresses don't identify customers.

Businesses need:

* Customer profiles
* CRM integration
* Purchase history
* Loyalty programs

---

### 15. Cross-Border Settlement

Receiving crypto is easy.

Paying suppliers in local currencies isn't.

Merchants want:

* Local bank transfers
* Multi-currency settlement
* FX optimization

---

### 16. POS (Point-of-Sale) Integration

Physical stores need:

* QR generation
* Receipt printing
* Staff-friendly interfaces
* Integration with POS systems

Many crypto gateways focus only on e-commerce.

---

### 17. ERP & E-commerce Integrations

Businesses rely on:

* Shopify
* WooCommerce
* Magento
* SAP
* Oracle
* Odoo

Many gateways provide limited or outdated integrations.

---

### 18. Lack of Business Insights

Merchants want dashboards answering questions like:

* Which customers pay with crypto most?
* Which token converts best?
* Which countries generate the highest revenue?
* Average payment time
* Payment abandonment rate
* Lifetime customer value

Most gateways provide only basic transaction lists.

---

### 19. Network Fees

Customers dislike paying:

* $20–$50 gas fees on Ethereum

Merchants want:

* Smart routing
* Lowest-fee network selection
* Gas sponsorship where appropriate

---

### 20. Developer Experience

APIs are often:

* Poorly documented
* Inconsistent
* Missing webhooks
* Lacking SDKs
* Difficult to test

Developers prefer integrations that take hours—not weeks.

---

# Emerging Pain Points (2026 and Beyond)

As crypto adoption grows, new challenges are becoming more important:

* **AI-powered fraud detection** for wallet risk and transaction anomalies.
* **Stablecoin yield management**, where idle balances can earn returns automatically.
* **Unified multi-chain treasury**, so merchants don't manually manage assets across ecosystems.
* **Programmable payouts**, such as automatic revenue sharing with vendors or affiliates.
* **On-chain identity and reputation**, reducing reliance on anonymous wallet addresses.
* **Embedded financing**, using crypto receivables to access working capital.

# The Biggest Opportunity

The next generation of crypto payment gateways won't win by simply helping merchants **accept crypto**. They'll win by becoming an **end-to-end financial operating system** that handles:

* Accepting payments from any wallet or chain.
* Instantly settling into the merchant's preferred currency.
* Automating accounting, reconciliation, and tax reporting.
* Managing treasury and liquidity.
* Detecting fraud and simplifying compliance.
* Integrating seamlessly with existing business tools.
* Providing actionable analytics to improve sales and operations.

For markets like Africa, there's an additional opportunity: enabling merchants to accept global stablecoin payments while settling directly into local bank accounts or mobile money, reducing cross-border payment friction without requiring merchants to become crypto experts.
