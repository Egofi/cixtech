import type { RlpInput } from "@/types";
import { concatBytes } from "@noble/hashes/utils";

export function toMinimalBytes(n: bigint): Uint8Array {
  if (n < 0n) throw new Error("cannot RLP-encode a negative integer");
  if (n === 0n) return new Uint8Array(0);
  let hex = n.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  return Uint8Array.from(Buffer.from(hex, "hex"));
}

function encodeLength(len: number, offset: number): Uint8Array {
  if (len < 56) return Uint8Array.of(offset + len);
  const lenBytes = toMinimalBytes(BigInt(len));
  return concatBytes(Uint8Array.of(offset + 55 + lenBytes.length), lenBytes);
}

function encodeBytes(b: Uint8Array): Uint8Array {
  if (b.length === 1 && (b[0] as number) < 0x80) return b;
  return concatBytes(encodeLength(b.length, 0x80), b);
}

export function rlpEncode(input: RlpInput): Uint8Array {
  if (input instanceof Uint8Array) return encodeBytes(input);
  if (typeof input === "bigint") return encodeBytes(toMinimalBytes(input));
  const payload = concatBytes(...input.map(rlpEncode));
  return concatBytes(encodeLength(payload.length, 0xc0), payload);
}
