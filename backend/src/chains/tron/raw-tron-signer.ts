import type { Signer } from "@/signing";
import { secp256k1 } from "@noble/curves/secp256k1";
import { tronAddressFromPubkey } from "./address.js";

export class RawTronSigner implements Signer {
  readonly address: string;
  private readonly privateKey: Uint8Array;

  constructor(privateKeyHex: string) {
    const clean = privateKeyHex.replace(/^0x/, "");
    if (clean.length !== 64) throw new Error("private key must be 32 bytes (64 hex chars)");
    this.privateKey = Uint8Array.from(Buffer.from(clean, "hex"));
    this.address = tronAddressFromPubkey(secp256k1.getPublicKey(this.privateKey, false));
  }

  deriveAddress(_index: number): string {
    return this.address;
  }

  signHash(_index: number, hash: Uint8Array): Uint8Array {
    if (hash.length !== 32) throw new Error("hash must be 32 bytes");
    const sig = secp256k1.sign(hash, this.privateKey);
    const out = new Uint8Array(65);
    out.set(sig.toCompactRawBytes(), 0);
    out[64] = sig.recovery;
    return out;
  }
}
