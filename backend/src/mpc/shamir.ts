import type { Share } from "@/types";
import { secp256k1 } from "@noble/curves/secp256k1";

export const ORDER = secp256k1.CURVE.n;

export function mod(a: bigint, n: bigint = ORDER): bigint {
  const r = a % n;
  return r >= 0n ? r : r + n;
}

export function invMod(a: bigint, n: bigint = ORDER): bigint {
  let [oldR, r] = [mod(a, n), n];
  let [oldS, s] = [1n, 0n];
  while (r !== 0n) {
    const q = oldR / r;
    [oldR, r] = [r, oldR - q * r];
    [oldS, s] = [s, oldS - q * s];
  }
  if (oldR !== 1n) throw new Error("value is not invertible mod n");
  return mod(oldS, n);
}

export function randomScalar(): bigint {
  return mod(bytesToScalar(secp256k1.utils.randomPrivateKey()));
}

export function bytesToScalar(b: Uint8Array): bigint {
  return BigInt(`0x${Buffer.from(b).toString("hex")}`);
}

export function scalarToBytes(x: bigint): Uint8Array {
  return Uint8Array.from(Buffer.from(mod(x).toString(16).padStart(64, "0"), "hex"));
}

export function evalPoly(coeffs: bigint[], x: bigint): bigint {
  let acc = 0n;
  for (let i = coeffs.length - 1; i >= 0; i--) acc = mod(acc * x + (coeffs[i] as bigint));
  return acc;
}

export function split(secret: bigint, t: number, n: number): Share[] {
  if (t < 1 || t > n) throw new Error(`invalid threshold ${t} of ${n}`);
  const coeffs = [mod(secret), ...Array.from({ length: t - 1 }, () => randomScalar())];
  return Array.from({ length: n }, (_, i) => {
    const x = BigInt(i + 1);
    return { x, y: evalPoly(coeffs, x) };
  });
}

export function combine(shares: Share[]): bigint {
  let secret = 0n;
  for (const { x: xi, y: yi } of shares) {
    let num = 1n;
    let den = 1n;
    for (const { x: xj } of shares) {
      if (xj === xi) continue;
      num = mod(num * mod(-xj));
      den = mod(den * mod(xi - xj));
    }
    const lagrange = mod(num * invMod(den));
    secret = mod(secret + mod(yi * lagrange));
  }
  return secret;
}

export function refresh(shares: Share[], t: number): Share[] {
  const zeroPoly = [0n, ...Array.from({ length: t - 1 }, () => randomScalar())];
  return shares.map(({ x, y }) => ({ x, y: mod(y + evalPoly(zeroPoly, x)) }));
}
