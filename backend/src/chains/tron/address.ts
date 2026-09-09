import { secp256k1 } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha2";
import { keccak_256 } from "@noble/hashes/sha3";
import { base58check } from "@scure/base";
import { HDKey } from "@scure/bip32";

const b58check = base58check(sha256);

const TRON_ADDRESS_PREFIX = 0x41;

function keccak20(compressedOrUncompressedPubkey: Uint8Array): Uint8Array {
  const uncompressed = secp256k1.Point.fromBytes(compressedOrUncompressedPubkey).toBytes(false);
  return keccak_256(uncompressed.subarray(1)).subarray(-20);
}

export function accountHash20(pubkey: Uint8Array): Uint8Array {
  return keccak20(pubkey);
}

export function tronAddressFromPubkey(pubkey: Uint8Array): string {
  const payload = new Uint8Array(21);
  payload[0] = TRON_ADDRESS_PREFIX;
  payload.set(keccak20(pubkey), 1);
  return b58check.encode(payload);
}

export function decodeTronAddress(address: string): Uint8Array {
  return b58check.decode(address);
}

export function tronAddressFromHex(hex: string): string {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const bytes = Uint8Array.from(Buffer.from(clean, "hex"));
  if (bytes.length !== 21 || bytes[0] !== TRON_ADDRESS_PREFIX) {
    throw new Error(`Not a 21-byte 0x41 Tron address payload: ${hex}`);
  }
  return b58check.encode(bytes);
}

export function deriveTronAddress(xpub: string, index: number): string {
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(`Derivation index must be a non-negative integer, got ${index}`);
  }
  const account = HDKey.fromExtendedKey(xpub.trim());
  const child = account.deriveChild(0).deriveChild(index);
  if (!child.publicKey) throw new Error("Could not derive a public key from the xpub");
  return tronAddressFromPubkey(child.publicKey);
}
