import { KeypairSigner } from "@/signing/keypair-signer.js";
import { secp256k1 } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha2";
import { HDKey } from "@scure/bip32";
import { describe, expect, it } from "vitest";

const seed = Uint8Array.from(Buffer.from("000102030405060708090a0b0c0d0e0f", "hex"));
const master = HDKey.fromMasterSeed(seed).derive("m/44'/195'/0'");
const XPRV = master.privateExtendedKey;
const hexEncode = (pub: Uint8Array) => Buffer.from(pub).toString("hex");

describe("KeypairSigner", () => {
  it("signs with the key that controls the derived address (recoverable)", () => {
    const signer = new KeypairSigner(XPRV, hexEncode);
    const hash = sha256(new TextEncoder().encode("payout intent"));

    for (const index of [0, 1, 7]) {
      const sig = signer.signHash(index, hash);
      expect(sig).toHaveLength(65);

      const recovered = secp256k1.Signature.fromCompact(sig.subarray(0, 64))
        .addRecoveryBit(sig[64] as number)
        .recoverPublicKey(hash)
        .toRawBytes(true);
      const expected = master.deriveChild(0).deriveChild(index).publicKey;
      expect(Buffer.from(recovered).toString("hex")).toBe(
        Buffer.from(expected as Uint8Array).toString("hex"),
      );
      expect(signer.deriveAddress(index)).toBe(hexEncode(expected as Uint8Array));
    }
  });

  it("produces a valid signature that verifies against the derived key", () => {
    const signer = new KeypairSigner(XPRV, hexEncode);
    const hash = sha256(new TextEncoder().encode("tx"));
    const sig = signer.signHash(0, hash);
    const pub = master.deriveChild(0).deriveChild(0).publicKey as Uint8Array;
    expect(secp256k1.verify(sig.subarray(0, 64), hash, pub)).toBe(true);
  });

  it("refuses an xpub (public-only) key", () => {
    expect(() => new KeypairSigner(master.publicExtendedKey, hexEncode)).toThrow();
  });

  it("rejects a non-32-byte hash", () => {
    const signer = new KeypairSigner(XPRV, hexEncode);
    expect(() => signer.signHash(0, new Uint8Array(31))).toThrow();
  });
});
