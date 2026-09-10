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
- **Dealerless DKG with Feldman VSS** — each of `n` participants contributes its
  own secret + polynomial and publishes `g^coeff` commitments; every node's share
  is the sum of what it received, so the group key is Σ of the participants'
  secrets and **no single party chooses or sees the whole key even at genesis**.
  Every share is verifiable against the aggregated commitments (a bad dealer is
  detectable). The old dealer ceremony (`dkg`) remains for tests.
- **`SignerNode` per share, in its own trust domain**, each INDEPENDENTLY
  re-verifying a request before contributing (ADR 0007's second gate).
- **Proactive refresh** (`refreshKeyShares`) — re-randomize shares without changing
  the key and bump an **epoch**; the signer refuses to combine shares from
  different epochs, forcing an attacker to compromise `t` nodes within one epoch.
- **Fail-closed guards on the interim** (hardening): the reconstruct-to-sign path
  throws in `production` outright, and otherwise requires explicit
  `acknowledgeInterim` — so the not-yet-audited protocol can never sign mainnet
  value or be reached by accident.
- **Robust verification at signing**: each contribution is checked against the VSS
  commitments (a corrupted/malicious share is rejected *with attribution*), the
  reconstructed key is verified to equal the group key before signing, and the
  emitted signature is verified to recover to the group key — the signer never
  emits a signature under an unexpected key.
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
- HSM-sealed share storage and the authenticated network protocol between nodes
  (this build models nodes in-process, and refresh invalidates genesis
  commitments — a real deployment reruns VSS to publish fresh ones) are the
  remaining production pieces. Dealerless DKG is now built.
- Refresh cadence, quorum sizes per key tier (hot 2-of-3 / warm 3-of-5 / cold
  4-of-7, ADR 0007), and the node authorization-token format are follow-ups.
