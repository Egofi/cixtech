import { BadContributionError } from "@/common";
import { dealerlessDkg, verifyShare } from "@/mpc/dealerless-dkg.js";
import { combine, scalarToBytes } from "@/mpc/shamir.js";
import { thresholdSignerFromShares } from "@/mpc/threshold-signer.js";
import { secp256k1 } from "@noble/curves/secp256k1";
import { describe, expect, it } from "vitest";

describe("dealerless DKG + verifiable secret sharing", () => {
  it("produces a group key nobody chose, reconstructable from a threshold of shares", () => {
    const { shares, publicKey, commitments } = dealerlessDkg(3, 5);
    expect(commitments).toHaveLength(3);

    const secret = combine(shares.slice(0, 3).map((s) => s.share));
    expect(Buffer.from(secp256k1.getPublicKey(scalarToBytes(secret), true)).toString("hex")).toBe(
      Buffer.from(publicKey).toString("hex"),
    );
  });

  it("every share verifies against the aggregated commitments; a tampered one does not", () => {
    const { shares, commitments } = dealerlessDkg(3, 5);
    for (const s of shares) {
      expect(verifyShare(s.share.x, s.share.y, commitments)).toBe(true);
    }
    const [first] = shares;
    const bad = (first as (typeof shares)[number]).share;
    expect(verifyShare(bad.x, bad.y + 1n, commitments)).toBe(false);
  });

  it("the resulting shares drive the threshold signer to the group key", () => {
    const { shares, publicKey } = dealerlessDkg(3, 5);
    const signer = thresholdSignerFromShares(shares, publicKey, (p) =>
      Buffer.from(p).toString("hex"),
    );
    const hash = new Uint8Array(32).fill(9);
    const sig = signer.signHash(0, hash);
    expect(secp256k1.verify(sig.subarray(0, 64), hash, publicKey)).toBe(true);
  });

  it("a signer given the VSS commitments rejects a corrupted contribution", () => {
    const { shares, publicKey, commitments } = dealerlessDkg(3, 5);

    const first = shares[0] as (typeof shares)[number];
    const tampered = [
      { ...first, share: { ...first.share, y: first.share.y + 1n } },
      ...shares.slice(1),
    ];
    const signer = thresholdSignerFromShares(
      tampered,
      publicKey,
      (p) => Buffer.from(p).toString("hex"),
      { commitments },
    );
    expect(() => signer.signHash(0, new Uint8Array(32).fill(9))).toThrow(BadContributionError);
  });
});
