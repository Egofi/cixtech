# ADR 0008: A separately licensed custodian entity; egofi is a consumer

**Status:** Accepted — legal review with Nigerian counsel required before live volume

## Context

ADR 0006 makes us a custodian. In Nigeria that is **SEC registration as a
Digital Asset Custodian**, now firmly under SEC oversight per the Investments
and Securities Act 2025. ADR 0001 originally avoided this scope on purpose; we
are now deliberately re-entering it.

We also intend to sell the Custody Engine to other businesses — including
potential competitors of egofi. A single entity that both operates a payment
gateway and custodies rivals' funds is an unsellable conflict.

## Decision

**Pursue our own custodian licence, and hold it in a separate legal entity.**

- The **custodian entity** holds the licence, the regulatory capital, the
  client-asset segregation, and the liability. It operates the Custody Engine
  and sells custody at arm's length.
- **egofi (the PSP) becomes a customer of it**, on the same API and commercial
  terms as any other tenant — internally priced at cost, externally at market.

Expect, in shape (exact figures move — confirm with counsel against current SEC
rules): substantial minimum paid-up capital, a fidelity/insurance bond,
fit-and-proper directors, a resident compliance officer/MLRO, segregation and
custody-policy attestations, mandatory audits, and AML/CFT registration with
reporting to SEC and the NFIU. SEC's incubation route (ARIP) is the provisional
on-ramp to operate while the full licence is processed.

## Consequences

- **Go-live is licence-gated.** Build and testnet freely; holding real
  third-party value waits on the licence or ARIP provisional status. This and
  the MPC audit (ADR 0007) are the two critical-path gates — run both in
  parallel with the build, never after it.
- Client-asset segregation must be **provable in the ledger and the treasury**,
  not merely asserted — this is what ADR 0010's solvency invariant and
  proof-of-reserves exist to demonstrate. It is a licence condition, not a
  nice-to-have.
- Per-tenant key domains (ADR 0007) and per-tenant ledger namespacing (ADR 0010)
  are driven by this decision, not by engineering taste.
- The compliance module must be **pluggable per jurisdiction**: selling the
  engine abroad reopens licensing per market (EU MiCA, US state MTLs/trust
  charters). Start Nigeria; do not hardcode its rules into the core.
- Contractual liability with tenants must be explicit: we custody *their*
  end-users' funds. Clear SLA, liability allocation, and confirmation of whether
  the tenant needs its own registration.
- Bankruptcy-remoteness of the custodian entity is a structuring question for
  counsel, and a selling point to tenants.
