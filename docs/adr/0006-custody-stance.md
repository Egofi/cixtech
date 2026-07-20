# ADR 0006: The gateway custodies funds (supersedes ADR 0001)

**Status:** Accepted — supersedes egofi ADR 0001 (non-custodial stance, in the origin `egofi` repo)

## Context

ADR 0001 chose non-custody to stay outside licensed-custody scope. Tracing the
money path proved that stance is structurally unmonetizable:

- `DirectTransferRail` sends funds straight to a merchant-controlled address.
  egofi never touches the flow, so there is nothing to take a fee from. This
  rail handles same-asset payments, xpub mode, sub-$20 tickets, **and every
  ticket above the ~$1,500 AML-attention band** — i.e. the most valuable
  payments produce zero transactional revenue.
- `SwapProviderRail` earns only what ChangeNOW passively attributes to a partner
  API key. `providerFeePercent` is never read in the settlement path, no
  affiliate parameter is sent on `createExchange`, and `LedgerService.recordFee`
  is dead code — never called. Effective automatic revenue today: ~zero.
- A quote markup cannot work on a direct transfer: the extra simply lands in the
  merchant's address, not egofi's.

The only fee that survives non-custody is one paid by a counterparty who *does*
hold the float. That makes the platform's economics a function of someone else's
business model.

## Decision

egofi custodies. Customer payments land in engine-controlled addresses; egofi
credits the merchant's ledger balance **minus a 0.5% take** and pays out to the
merchant's external address **on their request**.

Custody is not built inside egofi. It is a **separate product** — the Custody
Engine (see `CUSTODY_ENGINE_BUILD_SPEC.md`) — which egofi consumes over an API
as its first tenant, and which is sold to other businesses as infrastructure.

## Consequences

- **The founding constraint is gone and a bigger one replaces it.** Custody is a
  licensed activity (ADR 0008) and makes us a honeypot. Key management (ADR
  0007) becomes existential rather than avoidable.
- Revenue becomes enforceable and rail-independent: 0.5% applies to every
  confirmed deposit, including the large tickets the router steers away from
  swaps.
- The $1,500 AML steering band in `RailRouter` is now a **risk** decision only,
  no longer a revenue leak.
- The merchant xpub-sweep/dust problem disappears for custodial merchants:
  fragmentation moves inside the engine, which amortizes it (ADR 0009).
- `DirectTransferRail` remains for merchants who opt out of custody. The product
  now has two postures — custodial (monetized) and non-custodial (unmonetized) —
  and that choice must be explicit per merchant.
- New failure mode with no non-custodial equivalent: **tainted inbound
  deposits**. Anyone can send us sanctioned funds and we are then holding them.
  Screen on detection; never auto-credit high-risk deposits (ADR 0010).
