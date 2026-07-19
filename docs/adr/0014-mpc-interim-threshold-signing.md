# ADR 0014: MPC — interim threshold-shares now, audited CMP TSS at the seam

**Status:** Accepted — the signing *core* is explicitly NOT production until audited

## Context

ADR 0007 committed to in-house threshold MPC (CMP, secp256k1 + HSM) with the
load-bearing property: **the full private key never exists — not at generation,
not at signing, not in recovery.** True threshold-ECDSA (GG/CMP/DKLs) is
audit-grade cryptography (Paillier, range proofs, multi-round MtA). It must never
be hand-rolled; doing so and shipping it would be worse than a single hot key.

We still want the *architecture* around signing — the `Signer` port, node
separation, per-node re-verification, DKG, proactive refresh — built and proven,
so the only remaining gap is the cryptographic core, isolated behind a seam.

## Decision

Ship `@cixtech/mpc` as an **interim threshold signer** built from sound, standard
primitives, with the TSS core marked as the seam an audited protocol replaces:

- **Shamir sharing over the secp256k1 scalar field** — `t`-of-`n`, any `t` shares
  reconstruct, any `t-1` reveal nothing. Standard, property-tested.
- **DKG ceremony** (dealer generates + splits). Dealerless DKG is the documented
  upgrade.
- **`SignerNode` per share, in its own trust domain**, each INDEPENDENTLY
  re-verifying a request before contributing (ADR 0007's second gate).
- **Proactive refresh** — re-randomize shares without changing the key; a mix of
  old- and new-epoch shares does not reconstruct, forcing same-epoch compromise.
- **`ThresholdSigner implements Signer`** — drops into the payout broadcaster and
  pool exactly like `KeypairSigner` (proven: a 3-of-5 signature drives a Tron
  payout and recovers to the threshold address).

**The explicit interim / seam:** signing `combine`s the `t` contributions by
**reconstructing the key inside the coordinator**, then signs. So the key IS
briefly assembled at signing time. This is a real improvement over a single hot
key (no node holds the whole key at rest; `t`-of-`n`; per-node veto; proactive
refresh) but it does **not** meet ADR 0007's "never assembled." The
`contribute → combine` boundary is exactly where an **audited CMP threshold-ECDSA
implementation** replaces reconstruction with partial signatures.

## Consequences

- The `Signer` abstraction is validated end to end: KeypairSigner (HD),
  RawTronSigner (hot key), and ThresholdSigner (MPC) are interchangeable, and an
  audited CMP signer will be too — no caller changes (ADR 0007 delivered on its
  purpose).
- **Not production until the seam is filled.** The interim reconstruct-to-sign
  must be replaced by a vetted, audited TSS (the CMP core) before this signs real
  value. That audit is the long pole ADR 0007 named.
- HSM-sealed share storage, dealerless DKG, and the network protocol between
  nodes (this build models nodes in-process) are the remaining production pieces.
- Refresh cadence, quorum sizes per key tier (hot 2-of-3 / warm 3-of-5 / cold
  4-of-7, ADR 0007), and the node authorization-token format are follow-ups.
