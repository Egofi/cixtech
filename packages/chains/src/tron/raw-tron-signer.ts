import { secp256k1 } from "@noble/curves/secp256k1";
import { tronAddressFromPubkey } from "./address.js";

/**
 * A single raw-key Tron signer — for a treasury/hot address created directly from
 * a private key rather than HD-derived. Same signing primitive as
 * `@cixtech/signing`'s KeypairSigner (65-byte recoverable secp256k1), scoped to
 * one key. The key never leaves this object.
 */
export class RawTronSigner {
  readonly address: string;
  private readonly privateKey: Uint8Array;

  constructor(privateKeyHex: string) {
    const clean = privateKeyHex.replace(/^0x/, "");
    if (clean.length !== 64) throw new Error("private key must be 32 bytes (64 hex chars)");
    this.privateKey = Uint8Array.from(Buffer.from(clean, "hex"));
    this.address = tronAddressFromPubkey(secp256k1.getPublicKey(this.privateKey, false));
  }

  /** Sign a Tron txID (hex sha256 of raw_data) → 65-byte r‖s‖v signature, hex-encoded. */
  signTxId(txIdHex: string): string {
    const hash = Uint8Array.from(Buffer.from(txIdHex.replace(/^0x/, ""), "hex"));
    const sig = secp256k1.sign(hash, this.privateKey);
    const out = new Uint8Array(65);
    out.set(sig.toCompactRawBytes(), 0);
    out[64] = sig.recovery;
    return Buffer.from(out).toString("hex");
  }
}
