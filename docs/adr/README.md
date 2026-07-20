# cixtech ADRs

Architecture decisions for the cixtech custody engine.

The set opens at **0006** because ADRs 0001–0005 belong to the origin `egofi`
gateway (its non-custodial era); ADR 0006 records the custody pivot that gave
rise to cixtech and supersedes egofi's ADR 0001.

- **0006** — custody stance (the gateway custodies funds)
- **0007** — in-house secp256k1 threshold MPC + HSM signing
- **0008** — licensed custodian entity
- **0009** — deposit attribution (bounded pool + cool-off)
- **0010** — ledger solvency invariant
- **0011** — gather-strategy port
- **0012** — error identity and audit
- **0013** — database host
- **0014** — MPC interim threshold signing
- **0015** — super-admin console
- **0016** — multi-chain engine

The build spec (`../CUSTODY_ENGINE_BUILD_SPEC.md`) and the step-1 ledger plan
(`../CIXTECH_STEP1_LEDGER_CORE.md`) sit alongside this directory.
