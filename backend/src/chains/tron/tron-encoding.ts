import { decodeTronAddress } from "./address.js";

export function tronAddressToHex(base58: string): string {
  return Buffer.from(decodeTronAddress(base58)).toString("hex");
}

export function abiEncodeTransfer(toBase58: string, amount: bigint): string {
  if (amount <= 0n) throw new Error(`transfer amount must be positive, got ${amount}`);
  const to20 = decodeTronAddress(toBase58).subarray(1);
  const addr = Buffer.from(to20).toString("hex").padStart(64, "0");
  const value = amount.toString(16).padStart(64, "0");
  return addr + value;
}
