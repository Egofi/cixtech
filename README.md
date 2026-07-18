# cixtech

Licensed multi-tenant crypto-custody engine (Wallet-as-a-Service). egofi is the
first tenant; the engine is sold to other businesses as infrastructure.

> Governing spec and decisions live with the custodian entity. See
> `CUSTODY_ENGINE_BUILD_SPEC.md` and ADRs 0006–0011.

## Status — Build Step 1: ledger core + config spine

The only step with **zero external dependencies** — no keys, no chains, no
network. It proves the accounting before anything can move money, and ships the
config discipline that keeps the testnet→mainnet switch a config swap.

```
packages/
  types/         @cixtech/types        branded ids, money, account taxonomy
  ledger/        @cixtech/ledger        pure double-entry core + solvency invariant
  chain-config/  @cixtech/chain-config  per-(chain, env) registry + token registry
tooling/
  no-magic-constants/  CI guard: no chain id / address / rpc literal outside chain-config
```

### Getting started

```bash
pnpm install
pnpm typecheck
pnpm test           # Vitest + fast-check property suites
pnpm guard:constants
```

### The invariant that gates everything

```
Σ ASSET(pool_addr + treasury + cold + gas_float)
    ≥ Σ LIABILITY(available + pending + pending_withdrawal + compliance_suspense)   (per asset)
```

Enforced continuously; a drift freezes withdrawals. See `packages/ledger`.

**Nothing in later steps may move value until every property in
`packages/ledger/test` is green.**
