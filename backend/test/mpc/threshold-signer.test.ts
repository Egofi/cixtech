import {
  InterimForbiddenError,
  NodeRejectedError,
  SignerNode,
  ThresholdSigner,
  dkg,
  refreshKeyShares,
  thresholdSignerFromShares,
} from "@/mpc/threshold-signer.js";
import { secp256k1 } from "@noble/curves/secp256k1";
import { describe, expect, it } from "vitest";

const hexAddress = (pub: Uint8Array) => `0x${Buffer.from(pub).toString("hex")}`;
const hash = new Uint8Array(32).fill(7);

function recover(sig: Uint8Array): Uint8Array {
  return secp256k1.Signature.fromCompact(sig.subarray(0, 64))
    .addRecoveryBit(sig[64] as number)
    .recoverPublicKey(hash)
    .toRawBytes(true);
}

describe("ThresholdSigner (t-of-n, Signer port)", () => {
  it("3-of-5 nodes produce a signature that recovers to the threshold key", () => {
    const { shares, publicKey } = dkg(3, 5);
    const signer = thresholdSignerFromShares(shares, publicKey, hexAddress);

    expect(signer.deriveAddress(0)).toBe(hexAddress(publicKey));
    const sig = signer.signHash(0, hash);
    expect(sig).toHaveLength(65);
    // The distributed signature verifies + recovers to the SAME public key the DKG
    // committed to — no node ever held the whole key at rest.
    expect(secp256k1.verify(sig.subarray(0, 64), hash, publicKey)).toBe(true);
    expect(Buffer.from(recover(sig)).toString("hex")).toBe(Buffer.from(publicKey).toString("hex"));
  });

  it("refuses to construct without a threshold of nodes", () => {
    const { shares, publicKey } = dkg(3, 5);
    const twoNodes = shares.slice(0, 2).map((ks) => new SignerNode(ks));
    expect(
      () => new ThresholdSigner(twoNodes, 3, publicKey, hexAddress, { acknowledgeInterim: true }),
    ).toThrow();
  });

  it("fails closed: refuses the interim path in production, and without acknowledgment", () => {
    const { shares, publicKey } = dkg(3, 5);
    const nodes = shares.map((ks) => new SignerNode(ks));
    // No acknowledgment → refuse.
    expect(() => new ThresholdSigner(nodes, 3, publicKey, hexAddress)).toThrow(
      InterimForbiddenError,
    );
    // Production → refuse outright, even acknowledged.
    expect(
      () =>
        new ThresholdSigner(nodes, 3, publicKey, hexAddress, {
          acknowledgeInterim: true,
          production: true,
        }),
    ).toThrow(InterimForbiddenError);
    // Same guard via the convenience builder.
    expect(() =>
      thresholdSignerFromShares(shares, publicKey, hexAddress, { production: true }),
    ).toThrow(InterimForbiddenError);
  });

  it("a node that rejects the request blocks signing (independent re-verification)", () => {
    const { shares, publicKey } = dkg(3, 5);
    // The 2nd of the first three nodes vetoes → the quorum cannot form.
    const verifiers = [() => true, () => false, () => true, () => true, () => true];
    const signer = thresholdSignerFromShares(shares, publicKey, hexAddress, { verifiers });
    expect(() => signer.signHash(0, hash)).toThrow(NodeRejectedError);
  });

  it("keeps working across a proactive share refresh, and bumps the epoch", () => {
    const { shares, publicKey } = dkg(3, 5);
    const refreshed = refreshKeyShares(shares);
    expect(refreshed.every((s) => s.epoch === 1)).toBe(true);

    const signer = thresholdSignerFromShares(refreshed, publicKey, hexAddress);
    const sig = signer.signHash(0, hash);
    expect(secp256k1.verify(sig.subarray(0, 64), hash, publicKey)).toBe(true);
  });

  it("refuses to combine shares from different refresh epochs", () => {
    const { shares, publicKey } = dkg(3, 5);
    const refreshed = refreshKeyShares(shares);
    // Mix two epoch-0 shares with one epoch-1 share.
    const mixed = [shares[0], shares[1], refreshed[2]].map(
      (ks) => new SignerNode(ks as (typeof shares)[number]),
    );
    expect(
      () => new ThresholdSigner(mixed, 3, publicKey, hexAddress, { acknowledgeInterim: true }),
    ).toThrow();
  });
});
