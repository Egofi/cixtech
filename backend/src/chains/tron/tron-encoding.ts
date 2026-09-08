import { decodeTronAddress } from "./address.js";

/** Base58check Tron address → hex (0x41-prefixed, 21 bytes) as the node expects with visible:false. */
export function tronAddressToHex(base58: string): string {
  return Buffer.from(decodeTronAddress(base58)).toString("hex");
}

/**
 * ABI-encode `transfer(address,uint256)` params for a TRC20 transfer: the 20-byte
 * recipient (Tron address minus its 0x41 prefix) right-aligned in 32 bytes, then
 * the amount as a 32-byte big-endian integer. 128 hex chars total.
 */
export function abiEncodeTransfer(toBase58: string, amount: bigint): string {
  if (amount <= 0n) throw new Error(`transfer amount must be positive, got ${amount}`);
  const to20 = decodeTronAddress(toBase58).subarray(1); // drop the 0x41 prefix
  const addr = Buffer.from(to20).toString("hex").padStart(64, "0");
  const value = amount.toString(16).padStart(64, "0");
  return addr + value;
}
