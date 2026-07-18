import { secp256k1 } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha2";
import { keccak_256 } from "@noble/hashes/sha3";
import { base58check } from "@scure/base";
import { HDKey } from "@scure/bip32";

// Tron/BTC-style base58check: checksum = first 4 bytes of sha256(sha256(payload)).
const b58check = base58check(sha256);

// Tron mainnet & testnets share the 0x41 address prefix.
const TRON_ADDRESS_PREFIX = 0x41;

/** keccak256 of the uncompressed public key (minus its 0x04 tag), last 20 bytes. */
function keccak20(compressedOrUncompressedPubkey: Uint8Array): Uint8Array {
  const uncompressed = secp256k1.Point.fromBytes(compressedOrUncompressedPubkey).toBytes(false);
  return keccak_256(uncompressed.subarray(1)).subarray(-20);
}

/** The 20-byte account hash (identical to an EVM address's bytes) for a secp256k1 pubkey. */
export function accountHash20(pubkey: Uint8Array): Uint8Array {
  return keccak20(pubkey);
}

/** Tron base58check address: 0x41 || 20-byte keccak hash of the pubkey. */
export function tronAddressFromPubkey(pubkey: Uint8Array): string {
  const payload = new Uint8Array(21);
  payload[0] = TRON_ADDRESS_PREFIX;
  payload.set(keccak20(pubkey), 1);
  return b58check.encode(payload);
}

/** Decodes a Tron base58check address back to its 21-byte payload; throws if invalid. */
export function decodeTronAddress(address: string): Uint8Array {
  return b58check.decode(address);
}

/**
 * Derives a per-invoice receive address from a merchant's account-level xpub at
 * the standard BIP44 external path `<xpub>/0/index`. The merchant owns the seed,
 * so they hold the key for every derived address (ADR 0009 / non-custodial parity
 * in egofi; here the custodian holds the xpub's seed via the Signer).
 */
export function deriveTronAddress(xpub: string, index: number): string {
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(`Derivation index must be a non-negative integer, got ${index}`);
  }
  const account = HDKey.fromExtendedKey(xpub.trim());
  const child = account.deriveChild(0).deriveChild(index);
  if (!child.publicKey) throw new Error("Could not derive a public key from the xpub");
  return tronAddressFromPubkey(child.publicKey);
}
