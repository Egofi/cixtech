import { AppError } from "@cixtech/errors";
import type { Signer } from "@cixtech/signing";
import { secp256k1 } from "@noble/curves/secp256k1";
import { type Share, combine, randomScalar, scalarToBytes, split } from "./shamir.js";

/** Encodes the threshold public key into a chain address (injected — chain-agnostic). */
export type EncodeAddress = (publicKey: Uint8Array) => string;

export interface SigningContext {
  index: number;
  hash: Uint8Array;
}

export class NodeRejectedError extends AppError {
  readonly code = "MPC_NODE_REJECTED";
}
export class ThresholdNotMetError extends AppError {
  readonly code = "MPC_THRESHOLD_NOT_MET";
}

export interface KeyShare {
  nodeId: number;
  share: Share;
  publicKey: Uint8Array;
  threshold: number;
}

/**
 * Dealer ceremony: generate a secp256k1 key and Shamir-split it into `threshold`-
 * of-`n` shares. NOTE: a dealer generates+splits here; production uses a
 * dealerless DKG (each node contributes so no party ever sees the whole key, even
 * at genesis). This is the documented upgrade.
 */
export function dkg(threshold: number, n: number): { shares: KeyShare[]; publicKey: Uint8Array } {
  const secret = randomScalar();
  const publicKey = secp256k1.getPublicKey(scalarToBytes(secret), true);
  const shares = split(secret, threshold, n).map((share, i) => ({
    nodeId: i + 1,
    share,
    publicKey,
    threshold,
  }));
  return { shares, publicKey };
}

/**
 * One signing node: holds a single key share in its own trust domain and
 * INDEPENDENTLY re-verifies each request before contributing (ADR 0007's second
 * gate — a compromised coordinator cannot extract a contribution without also
 * satisfying the node's own check). `verify` stands in for the per-node
 * authorization-token + policy re-validation.
 */
export class SignerNode {
  constructor(
    private readonly keyShare: KeyShare,
    private readonly verify: (ctx: SigningContext) => boolean = () => true,
  ) {}

  get id(): number {
    return this.keyShare.nodeId;
  }

  contribute(ctx: SigningContext): Share {
    if (!this.verify(ctx)) {
      throw new NodeRejectedError(`Node ${this.keyShare.nodeId} rejected the signing request`, {
        context: { nodeId: this.keyShare.nodeId },
      });
    }
    return this.keyShare.share;
  }
}

/**
 * Threshold signer over the `Signer` port (ADR 0007) — drops into the payout
 * broadcaster and pool exactly like KeypairSigner. `t` of `n` nodes cooperate to
 * sign; no single node stores the whole key AT REST, and proactive refresh
 * (shamir.refresh) forces an attacker to compromise `t` nodes within one epoch.
 *
 * ⚠️ INTERIM — this is not the final protocol. The `combine` step RECONSTRUCTS the
 * key inside the coordinator to sign, so the key is briefly assembled at signing
 * time. That is a real improvement over a single hot key, but it does NOT yet meet
 * ADR 0007's "the key is never assembled." The `contribute → combine` seam is
 * exactly where an AUDITED threshold-ECDSA protocol (CMP) replaces reconstruction
 * with partial signatures. That crypto core must be a vetted implementation before
 * production — never hand-rolled.
 */
export class ThresholdSigner implements Signer {
  constructor(
    private readonly nodes: SignerNode[],
    private readonly threshold: number,
    private readonly publicKey: Uint8Array,
    private readonly encodeAddress: EncodeAddress,
  ) {
    if (nodes.length < threshold) {
      throw new ThresholdNotMetError(`need ${threshold} nodes, have ${nodes.length}`, {
        context: { threshold, nodes: nodes.length },
      });
    }
  }

  deriveAddress(_index: number): string {
    return this.encodeAddress(this.publicKey);
  }

  signHash(index: number, hash: Uint8Array): Uint8Array {
    if (hash.length !== 32) throw new Error("hash must be 32 bytes");
    const ctx: SigningContext = { index, hash };

    // Each node re-verifies independently before releasing its contribution.
    const quorum = this.nodes.slice(0, this.threshold);
    const contributions = quorum.map((node) => node.contribute(ctx));

    // ── the CMP seam: reconstruct + sign (INTERIM — see class doc) ────────────
    const d = combine(contributions);
    const sig = secp256k1.sign(hash, scalarToBytes(d));
    // ──────────────────────────────────────────────────────────────────────────

    const out = new Uint8Array(65);
    out.set(sig.toCompactRawBytes(), 0);
    out[64] = sig.recovery;
    return out;
  }
}

/** Build a ThresholdSigner from a DKG result, one node per share. */
export function thresholdSignerFromShares(
  shares: KeyShare[],
  publicKey: Uint8Array,
  encodeAddress: EncodeAddress,
  verifiers: Array<(ctx: SigningContext) => boolean> = [],
): ThresholdSigner {
  const threshold = shares[0]?.threshold ?? shares.length;
  const nodes = shares.map((ks, i) => new SignerNode(ks, verifiers[i]));
  return new ThresholdSigner(nodes, threshold, publicKey, encodeAddress);
}
