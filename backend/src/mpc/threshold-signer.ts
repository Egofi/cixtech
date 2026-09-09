import {
  BadContributionError,
  InterimForbiddenError,
  NodeRejectedError,
  ThresholdNotMetError,
} from "@/common";
import type { Signer } from "@/signing";
import type { KeyShare, Share, SigningContext, ThresholdSignerOptions } from "@/types";
import { secp256k1 } from "@noble/curves/secp256k1";
import { verifyShare } from "./dealerless-dkg.js";
import { combine, randomScalar, refresh, scalarToBytes, split } from "./shamir.js";

export type EncodeAddress = (publicKey: Uint8Array) => string;

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

    const quorum = this.nodes.slice(0, this.threshold);
    const contributions = quorum.map((node) => node.contribute(ctx));

    if (this.commitments) {
      for (const share of contributions) {
        if (!verifyShare(share.x, share.y, this.commitments)) {
          throw new BadContributionError("a contributed share failed its Feldman check", {
            context: { x: share.x.toString() },
          });
        }
      }
    }

    const d = combine(contributions);

    const recoveredPub = secp256k1.getPublicKey(scalarToBytes(d), true);
    if (Buffer.compare(Buffer.from(recoveredPub), Buffer.from(this.publicKey)) !== 0) {
      throw new BadContributionError("reconstructed key does not match the group public key");
    }
    const sig = secp256k1.sign(hash, scalarToBytes(d));

    const out = new Uint8Array(65);
    out.set(sig.toCompactRawBytes(), 0);
    out[64] = sig.recovery;

    if (!secp256k1.verify(out.subarray(0, 64), hash, this.publicKey)) {
      throw new BadContributionError("produced signature does not verify under the group key");
    }
    return out;
  }
}

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
