import { keccak_256 } from "@noble/hashes/sha3";
import { bytesToHex } from "@noble/hashes/utils";
import { HDKey } from "@scure/bip32";
import { accountHash20 } from "../tron/address.js";

export function normalizeHexAddress(address: string): string {
  const clean = address.toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{40}$/.test(clean)) throw new Error(`not a 20-byte hex address: ${address}`);
  return clean;
}

export function toChecksumAddress(address: string): string {
  const clean = normalizeHexAddress(address);
  const hash = bytesToHex(keccak_256(clean));
  let out = "0x";
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i] as string;
    out += Number.parseInt(hash[i] as string, 16) >= 8 ? c.toUpperCase() : c;
  }
  return out;
}

export function evmAddressFromPubkey(pubkey: Uint8Array): string {
  return toChecksumAddress(bytesToHex(accountHash20(pubkey)));
}

export function deriveEvmAddress(xpub: string, index: number): string {
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(`Derivation index must be a non-negative integer, got ${index}`);
  }
  const account = HDKey.fromExtendedKey(xpub.trim());
  const child = account.deriveChild(0).deriveChild(index);
  if (!child.publicKey) throw new Error("Could not derive a public key from the xpub");
  return evmAddressFromPubkey(child.publicKey);
}
