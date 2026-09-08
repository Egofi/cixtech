import { keccak_256 } from "@noble/hashes/sha3";
import { bytesToHex } from "@noble/hashes/utils";
import { HDKey } from "@scure/bip32";
import { accountHash20 } from "../tron/address.js";

/** Strip an optional 0x and validate a 40-hex-char address; returns the lowercase hex. */
export function normalizeHexAddress(address: string): string {
  const clean = address.toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{40}$/.test(clean)) throw new Error(`not a 20-byte hex address: ${address}`);
  return clean;
}

/**
 * EIP-55 mixed-case checksum: a hex nibble is upper-cased when the corresponding
 * nibble of keccak256(lowercase-ascii-address) is >= 8. Catches single-character
 * typos in an address without any registry.
 */
export function toChecksumAddress(address: string): string {
  const clean = normalizeHexAddress(address);
  const hash = bytesToHex(keccak_256(clean)); // keccak of the ASCII lowercase hex string
  let out = "0x";
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i] as string;
    out += Number.parseInt(hash[i] as string, 16) >= 8 ? c.toUpperCase() : c;
  }
  return out;
}

/** The checksummed 0x address for a secp256k1 public key. */
export function evmAddressFromPubkey(pubkey: Uint8Array): string {
  return toChecksumAddress(bytesToHex(accountHash20(pubkey)));
}

/**
 * Derive a receive/pool address from an account xpub at the BIP44 external path
 * `<xpub>/0/index` — same scheme as Tron, only the encoding differs (EIP-55 vs
 * base58check), because both chains hash a secp256k1 key to the same 20 bytes.
 * All EVM chains (Polygon, BSC, Arbitrum, Base, …) share one address for a key.
 */
export function deriveEvmAddress(xpub: string, index: number): string {
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(`Derivation index must be a non-negative integer, got ${index}`);
  }
  const account = HDKey.fromExtendedKey(xpub.trim());
  const child = account.deriveChild(0).deriveChild(index);
  if (!child.publicKey) throw new Error("Could not derive a public key from the xpub");
  return evmAddressFromPubkey(child.publicKey);
}
