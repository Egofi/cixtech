import { concatBytes } from "@noble/hashes/utils";

/**
 * Recursive Length Prefix — Ethereum's canonical serialization for transactions.
 * We accept byte strings, non-negative integers (encoded minimal big-endian, 0 →
 * empty string per the spec), and nested lists. Hand-rolling encoding-only RLP is
 * standard and fully covered by the known-vector tests; it is the exact byte
 * layout an EIP-1559 transaction is built from.
 */
export type RlpInput = Uint8Array | bigint | RlpInput[];

/** Minimal big-endian bytes of a non-negative integer; 0 → empty (RLP integer rule). */
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
  // A single byte < 0x80 is its own encoding; everything else gets a length prefix.
  if (b.length === 1 && (b[0] as number) < 0x80) return b;
  return concatBytes(encodeLength(b.length, 0x80), b);
}

export function rlpEncode(input: RlpInput): Uint8Array {
  if (input instanceof Uint8Array) return encodeBytes(input);
  if (typeof input === "bigint") return encodeBytes(toMinimalBytes(input));
  const payload = concatBytes(...input.map(rlpEncode));
  return concatBytes(encodeLength(payload.length, 0xc0), payload);
}
