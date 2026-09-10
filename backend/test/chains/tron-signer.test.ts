import { tronAddressFromPubkey } from "@/chains/tron/address.js";
import { makeTronSigner, signTronTxId } from "@/chains/tron/tron-signer.js";
import { secp256k1 } from "@noble/curves/secp256k1";
import { HDKey } from "@scure/bip32";
import { describe, expect, it } from "vitest";

const seed = Uint8Array.from(Buffer.from("101112131415161718191a1b1c1d1e1f", "hex"));
const XPRV = HDKey.fromMasterSeed(seed).derive("m/44'/195'/0'").privateExtendedKey;

describe("Tron keypair signing", () => {
  it("signs a txID with the key controlling the derived Tron address", () => {
    const signer = makeTronSigner(XPRV);
    const address = signer.deriveAddress(0);
    expect(address.startsWith("T")).toBe(true);

    const txId = "9c8e7d6f".repeat(8);
    const sigHex = signTronTxId(signer, 0, txId);
    const sig = Uint8Array.from(Buffer.from(sigHex, "hex"));
    expect(sig).toHaveLength(65);

    const hash = Uint8Array.from(Buffer.from(txId, "hex"));
    const recovered = secp256k1.Signature.fromCompact(sig.subarray(0, 64))
      .addRecoveryBit(sig[64] as number)
      .recoverPublicKey(hash)
      .toRawBytes(true);
    expect(tronAddressFromPubkey(recovered)).toBe(address);
  });
});
