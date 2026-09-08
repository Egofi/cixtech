/**
 * The signing port (ADR 0007). Chain-agnostic: it derives receive addresses and
 * signs 32-byte hashes with the key that controls them. Backed initially by a
 * keypair signer, later by in-house threshold MPC — the same interface, so
 * callers never change. Address *encoding* is chain-specific and injected, so
 * this layer depends on no chain package.
 */
export interface Signer {
  /** The receive address at a BIP44 external index (`m/44'/coin'/0'/0/index`). */
  deriveAddress(index: number): string;
  /** A 65-byte recoverable secp256k1 signature (r‖s‖v) over `hash`. */
  signHash(index: number, hash: Uint8Array): Uint8Array;
}
