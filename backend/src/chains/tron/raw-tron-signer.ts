import type { Signer } from "@/signing";
import { secp256k1 } from "@noble/curves/secp256k1";
import { tronAddressFromPubkey } from "./address.js";

/**
 * A single raw-key Tron signer — for a treasury/hot address created directly from
 * a private key rather than HD-derived. It implements the `@cixtech/signing`
 * `Signer` port (index-agnostic: one key, one address), so the payout broadcaster
 * treats it identically to an HD pool signer or, later, an MPC signer (ADR 0007).
 * The key never leaves this object.
 */
export class RawTronSigner implements Signer {
  readonly address: string;
  private readonly privateKey: Uint8Array;

  constructor(privateKeyHex: string) {
    const clean = privateKeyHex.replace(/^0x/, "");
    if (clean.length !== 64) throw new Error("private key must be 32 bytes (64 hex chars)");
    this.privateKey = Uint8Array.from(Buffer.from(clean, "hex"));
    this.address = tronAddressFromPubkey(secp256k1.getPublicKey(this.privateKey, false));
  }

  /** One key, so every index maps to the same address. */
  deriveAddress(_index: number): string {
    return this.address;
  }

  /** 65-byte recoverable secp256k1 signature (r‖s‖v) over a 32-byte hash. */
  signHash(_index: number, hash: Uint8Array): Uint8Array {
    if (hash.length !== 32) throw new Error("hash must be 32 bytes");
    const sig = secp256k1.sign(hash, this.privateKey);
    const out = new Uint8Array(65);
    out.set(sig.toCompactRawBytes(), 0);
    out[64] = sig.recovery;
    return out;
  }
}
