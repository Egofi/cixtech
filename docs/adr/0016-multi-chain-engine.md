# ADR 0016: Multi-chain engine — one router, per-chain plugins, durable cursors

**Status:** Accepted

## Context

The custody engine was proven end-to-end on Tron, and the EVM family (Polygon,
BSC, Arbitrum, Base) now exists as a `ChainAdapter` + broadcaster + balance
provider (ADR — EVM commit). But `apps/api` still wired a single Tron
broadcaster, balance provider, deposit source, and address deriver. To custody
value on many chains through one API, the engine must route every chain-touching
operation to the right chain — without the ledger, pool, policy, payout, or
webhook code learning that more than one chain exists.

The key enabler already exists: **every chain-touching port carries the chain**
— `PayoutRequest.chain`, `AddressBalance.balance(chain, …)`,
`deriveAddress(chain, …)`, `DepositSource.fetchInbound(chain, …)`. The Tron-only
wiring simply passed singletons that ignored it.

## Decision

Introduce a **`ChainRouter`**: a registry of per-chain **plugins**, each bundling
that chain's `broadcaster`, `balances`, `depositSource`, `deriveAddress`, and
`confirmations`. The router itself *implements the same ports* by dispatching on
the chain argument, so `buildEngine` consumes the router exactly where it used to
consume the singletons — the ledger/pool/payout/webhook code is untouched.

- **Unknown chain is a loud failure, never a silent default** (§16.5 philosophy):
  the router throws `UnsupportedChainError`, and the API validates `chain`
  against the router at the edge, returning a clear 400 before any state moves
  (no pool index is consumed for an unroutable chain).
- **One engine xpub, many encodings.** Tron and EVM both hash the same secp256k1
  key; a plugin's `deriveAddress` only differs in encoding, so a single engine
  seed serves every secp256k1 chain. (BTC/LTC/XRP will bring their own key
  domains later — the plugin boundary is where that lands.)

### Durable deposit cursors (enterprise-grade detection)

Tron detection is account-based and stateless (re-poll recent txs; the ledger
dedups on `txId`). EVM detection is **block-range log scanning**, which must be
**resumable**: a `deposit_cursor(chain, address, last_block)` table records how
far each address has been scanned. `EvmDepositSource` scans
`[cursor, head − confirmations]`, credits only finalized logs, and advances the
cursor transactionally — so a restart or a second node never rescans from genesis
nor skips a block. First sighting seeds the cursor a bounded lookback behind the
head (not genesis), so watching starts cheaply.

## Consequences

- Adding a chain is a plugin registration, not an engine change; the same seam
  will carry BTC/LTC/XRP.
- The detection loop iterates `router.chains()`; each chain polls independently,
  so one chain's RPC outage cannot stall the others (failures are isolated per
  chain per tick).
- The API exposes `GET /v1/chains` (the routable set) and rejects deposits /
  withdrawals on any other chain with `UNSUPPORTED_CHAIN` (400).
- The engine stays honest about finality per chain: each plugin carries its own
  confirmation depth, and only finalized deposits are credited.
- Follow-ups: per-chain health in `/ready`, native-gas deposit detection (EVM
  balances already read native for gathering), and the non-EVM key domains.
