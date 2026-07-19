import { AppError } from "@cixtech/errors";
import type { Signer } from "@cixtech/signing";
import { secp256k1 } from "@noble/curves/secp256k1";
import { verifyShare } from "./dealerless-dkg.js";
import { type Share, combine, randomScalar, refresh, scalarToBytes, split } from "./shamir.js";

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
/** A contributed share failed its Feldman check, or the reconstructed key was wrong. */
export class BadContributionError extends AppError {
  readonly code = "MPC_BAD_CONTRIBUTION";
}
/** The interim reconstruct-to-sign path was used without acknowledgment or in production. */
export class InterimForbiddenError extends AppError {
  readonly code = "MPC_INTERIM_FORBIDDEN";
}

export interface KeyShare {
  nodeId: number;
  share: Share;
  publicKey: Uint8Array;
  threshold: number;
  /** Proactive-refresh epoch; shares from different epochs must never be combined. */
  epoch: number;
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
    epoch: 0,
  }));
  return { shares, publicKey };
}

/**
 * Proactive refresh (ADR 0007): re-randomize every share WITHOUT changing the key,
 * and bump the epoch. New shares reconstruct the same key; a mix of old-epoch and
 * new-epoch shares does not — so a mobile attacker must compromise `threshold`
 * nodes within a SINGLE epoch. Any Feldman commitments from genesis no longer apply
 * after a refresh; a real deployment reruns VSS to publish fresh commitments.
 */
export function refreshKeyShares(keyShares: KeyShare[]): KeyShare[] {
  const threshold = keyShares[0]?.threshold ?? keyShares.length;
  const refreshed = refresh(
    keyShares.map((k) => k.share),
    threshold,
  );
  return keyShares.map((k, i) => ({
    ...k,
    share: refreshed[i] as Share,
    epoch: k.epoch + 1,
  }));
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

  get epoch(): number {
    return this.keyShare.epoch;
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

export interface ThresholdSignerOptions {
  /**
   * Aggregated Feldman commitments (from the dealerless DKG). When present, each
   * node's contribution is verified against them before combine, so a corrupted or
   * malicious share is REJECTED with attribution rather than silently producing a
   * wrong key. Omit only for the dealer ceremony / tests without a VSS transcript.
   */
  commitments?: Uint8Array[];
  /**
   * Must be `true` to permit the interim reconstruct-to-sign path. Fail-closed: a
   * caller has to consciously opt into the not-yet-final protocol; forgetting it
   * throws rather than signing insecurely.
   */
  acknowledgeInterim?: boolean;
  /**
   * When `true`, the interim path is forbidden OUTRIGHT — reconstruction must never
   * assemble a mainnet key. Wire this to the real environment flag at the edge so
   * the interim can never ship to production silently.
   */
  production?: boolean;
}

/**
 * Threshold signer over the `Signer` port (ADR 0007) — drops into the payout
 * broadcaster and pool exactly like KeypairSigner. `t` of `n` nodes cooperate to
 * sign; no single node stores the whole key AT REST, and proactive refresh
 * (refreshKeyShares) forces an attacker to compromise `t` nodes within one epoch.
 *
 * ⚠️ INTERIM — this is not the final protocol. The `combine` step RECONSTRUCTS the
 * key inside the coordinator to sign, so the key is briefly assembled at signing
 * time. That is a real improvement over a single hot key, but it does NOT yet meet
 * ADR 0007's "the key is never assembled." The `contribute → combine` seam is
 * exactly where an AUDITED threshold-ECDSA protocol (CMP) replaces reconstruction
 * with partial signatures. That crypto core must be a vetted implementation before
 * production — never hand-rolled. Until then this class is fail-closed: it refuses
 * to run in production and requires explicit acknowledgment of the interim.
 */
export class ThresholdSigner implements Signer {
  private readonly commitments: Uint8Array[] | undefined;

  constructor(
    private readonly nodes: SignerNode[],
    private readonly threshold: number,
    private readonly publicKey: Uint8Array,
    private readonly encodeAddress: EncodeAddress,
    options: ThresholdSignerOptions = {},
  ) {
    if (nodes.length < threshold) {
      throw new ThresholdNotMetError(`need ${threshold} nodes, have ${nodes.length}`, {
        context: { threshold, nodes: nodes.length },
      });
    }
    if (options.production) {
      throw new InterimForbiddenError(
        "Interim reconstruct-to-sign is forbidden in production; wire an audited threshold-ECDSA protocol first",
      );
    }
    if (!options.acknowledgeInterim) {
      throw new InterimForbiddenError(
        "ThresholdSigner uses interim key reconstruction; pass acknowledgeInterim to opt in",
      );
    }
    // All shares must share one epoch — mixing old + refreshed shares must not reconstruct.
    const epochs = new Set(nodes.map((n) => n.epoch));
    if (epochs.size > 1) {
      throw new BadContributionError("nodes span multiple refresh epochs", {
        context: { epochs: [...epochs].join(",") },
      });
    }
    this.commitments = options.commitments;
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

    // Verify each contribution against the VSS commitments (attributable rejection).
    if (this.commitments) {
      for (const share of contributions) {
        if (!verifyShare(share.x, share.y, this.commitments)) {
          throw new BadContributionError("a contributed share failed its Feldman check", {
            context: { x: share.x.toString() },
          });
        }
      }
    }

    // ── the CMP seam: reconstruct + sign (INTERIM — see class doc) ────────────
    const d = combine(contributions);
    // Fail closed: never sign unless the reconstructed key IS the group key.
    const recoveredPub = secp256k1.getPublicKey(scalarToBytes(d), true);
    if (Buffer.compare(Buffer.from(recoveredPub), Buffer.from(this.publicKey)) !== 0) {
      throw new BadContributionError("reconstructed key does not match the group public key");
    }
    const sig = secp256k1.sign(hash, scalarToBytes(d));
    // ──────────────────────────────────────────────────────────────────────────

    const out = new Uint8Array(65);
    out.set(sig.toCompactRawBytes(), 0);
    out[64] = sig.recovery;
    // Belt-and-suspenders: the emitted signature must verify under the group key.
    if (!secp256k1.verify(out.subarray(0, 64), hash, this.publicKey)) {
      throw new BadContributionError("produced signature does not verify under the group key");
    }
    return out;
  }
}

/** Build a ThresholdSigner from a DKG result, one node per share. */
export function thresholdSignerFromShares(
  shares: KeyShare[],
  publicKey: Uint8Array,
  encodeAddress: EncodeAddress,
  options: {
    verifiers?: Array<(ctx: SigningContext) => boolean>;
    commitments?: Uint8Array[];
    acknowledgeInterim?: boolean;
    production?: boolean;
  } = {},
): ThresholdSigner {
  const threshold = shares[0]?.threshold ?? shares.length;
  const nodes = shares.map((ks, i) => new SignerNode(ks, options.verifiers?.[i]));
  return new ThresholdSigner(nodes, threshold, publicKey, encodeAddress, {
    acknowledgeInterim: options.acknowledgeInterim ?? true,
    ...(options.commitments ? { commitments: options.commitments } : {}),
    ...(options.production !== undefined ? { production: options.production } : {}),
  });
}
