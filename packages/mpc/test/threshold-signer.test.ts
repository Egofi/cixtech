import { secp256k1 } from "@noble/curves/secp256k1";
import { describe, expect, it } from "vitest";
import { type Share, refresh } from "../src/shamir.js";
import {
  NodeRejectedError,
  SignerNode,
  ThresholdSigner,
  dkg,
  thresholdSignerFromShares,
} from "../src/threshold-signer.js";

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
    expect(() => new ThresholdSigner(twoNodes, 3, publicKey, hexAddress)).toThrow();
  });

  it("a node that rejects the request blocks signing (independent re-verification)", () => {
    const { shares, publicKey } = dkg(3, 5);
    // The 2nd of the first three nodes vetoes → the quorum cannot form.
    const verifiers = [() => true, () => false, () => true, () => true, () => true];
    const signer = thresholdSignerFromShares(shares, publicKey, hexAddress, verifiers);
    expect(() => signer.signHash(0, hash)).toThrow(NodeRejectedError);
  });

  it("keeps working across a proactive share refresh (same key)", () => {
    const { shares, publicKey } = dkg(3, 5);
    const newRaw = refresh(
      shares.map((s) => s.share),
      3,
    );
    const refreshed = shares.map((ks, i) => ({ ...ks, share: newRaw[i] as Share }));

    const signer = thresholdSignerFromShares(refreshed, publicKey, hexAddress);
    const sig = signer.signHash(0, hash);
    expect(secp256k1.verify(sig.subarray(0, 64), hash, publicKey)).toBe(true);
  });
});
