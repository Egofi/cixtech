# ADR 0007: In-house secp256k1 threshold MPC + HSM signing

**Status:** Accepted

## Context

Custody (ADR 0006) means holding keys for other people's money. The options were
buying an MPC/custody vendor (Fireblocks/BitGo/DFNS/Cobo), building in-house, or
a hybrid. Because the Custody Engine is itself the product we intend to sell as
infrastructure (ADR 0008), renting the core competence from a vendor both caps
the margin and undermines the pitch.

## Decision

Build **threshold signing (TSS) in-house**, on **secp256k1 ECDSA**, with each
key share sealed in an HSM.

**One curve covers everything.** Polygon, BSC, Arbitrum, Base, Tron, BTC, LTC
and XRP can all sign with secp256k1 (XRP supports ed25519 but defaults to
secp256k1). One threshold scheme covers the entire launch chain set. An ed25519
threshold path (FROST) is deferred until Solana/Stellar.

**DKG once, derive many.** Distributed key generation per *key domain*, not per
address. Deposit addresses are BIP32 non-hardened derivations of the shared
public key; signing applies an additive key-tweak to the existing shares. One
DKG yields unlimited addresses.

**Key domains** — per tenant (client-asset segregation is a licence
requirement), tiered:

| Domain | Quorum | Holds | Signing |
| ------ | ------ | ----- | ------- |
| **pool (warm)** | 3-of-5 | **the working float — deposits stay here (ADR 0009)** | payout only; no auto-signing |
| treasury | 3-of-5 | swept fee revenue | policy-gated |
| cold | 4-of-7 | idle-balance consolidation, if adopted | human quorum + time-lock |

Note the pool domain sits at **warm quorum, not hot**. That is affordable
precisely *because* payouts are merchant-initiated and infrequent — there is no
per-deposit sweep demanding fast automated signing (ADR 0009).

**The full private key is never assembled** — not at DKG, not at signing, not in
recovery. Nodes run in separate cloud accounts / regions / operator domains, so
compromising k-1 nodes reveals nothing and signs nothing.

**Signing flow:**

```
1. Withdrawal intent → engine API (authenticated, idempotent)
2. POLICY ENGINE evaluates → emits a signed, short-lived AUTHORIZATION TOKEN
3. Orchestrator builds unsigned tx, computes sighash, attaches token + path
4. Coordinator requests a threshold signature
   → each node INDEPENDENTLY verifies before contributing its share
5. TSS rounds → signature assembled → broadcast
6. Ledger posting: pending → confirmed at chain finality
```

**The node re-check must be independently grounded.** A node that only verifies
"a token signed by the policy service" proves nothing if that service is
compromised. Nodes therefore verify things they can evaluate without trusting
the backend:

1. **Human approval signatures** (operator keys the nodes know) for large
   withdrawals — a fully-compromised backend still cannot fabricate an approval.
2. **Coarse per-domain rate limits** from the node's own local state.
3. **Token bound to the exact `sighash`** — otherwise a valid token is replayed
   against a different transaction.

Without all three the quorum is decorative.

**Lifecycle:** witnessed DKG ceremony (a licence artifact); proactive share
refresh on a schedule (rotates shares without changing addresses, defeating a
slow intruder); node recovery by re-sharing from the remaining quorum;
geographically distributed cold share backup with a break-glass procedure gated
by time-lock + multi-party.

## Consequences

- Requires a dedicated cryptography/security function and an **external
  cryptographic audit** before touching real value. That audit is the long pole.
- **Launch is not gated on it.** The `Signer` port is defined from day one; the
  in-house MPC is developed on testnet behind it while early real volume runs on
  a single HSM-guarded, tightly-capped hot wallet under the *same* policy
  engine. Cut over on audit completion — same interface, no rewrite.
- No vendor bps on signing → the engine keeps full margin, which is the point.
- HSM attestations, ceremony records and the key-management policy are direct
  inputs to the licence application (ADR 0008) and proof-of-reserves (ADR 0010).
