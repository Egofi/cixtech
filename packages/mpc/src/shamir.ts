import { secp256k1 } from "@noble/curves/secp256k1";

/** The secp256k1 group order — all share arithmetic is mod n (the scalar field). */
export const ORDER = secp256k1.CURVE.n;

export function mod(a: bigint, n: bigint = ORDER): bigint {
  const r = a % n;
  return r >= 0n ? r : r + n;
}

/** Modular inverse via the extended Euclidean algorithm. Throws if not invertible. */
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

/** A uniformly-random non-zero scalar in [1, n-1]. */
export function randomScalar(): bigint {
  return mod(bytesToScalar(secp256k1.utils.randomPrivateKey()));
}

export function bytesToScalar(b: Uint8Array): bigint {
  return BigInt(`0x${Buffer.from(b).toString("hex")}`);
}

/** A 32-byte big-endian encoding of a scalar (a secp256k1 private key). */
export function scalarToBytes(x: bigint): Uint8Array {
  return Uint8Array.from(Buffer.from(mod(x).toString(16).padStart(64, "0"), "hex"));
}

export interface Share {
  /** Evaluation point (the node's id), 1-based; never 0 (that is the secret). */
  x: bigint;
  y: bigint;
}

function evalPoly(coeffs: bigint[], x: bigint): bigint {
  // Horner's method, mod n.
  let acc = 0n;
  for (let i = coeffs.length - 1; i >= 0; i--) acc = mod(acc * x + (coeffs[i] as bigint));
  return acc;
}

/**
 * Shamir-split `secret` into `n` shares with threshold `t`: any `t` shares
 * reconstruct it, any `t-1` reveal nothing. The polynomial's constant term is the
 * secret; the other `t-1` coefficients are uniformly random.
 */
export function split(secret: bigint, t: number, n: number): Share[] {
  if (t < 1 || t > n) throw new Error(`invalid threshold ${t} of ${n}`);
  const coeffs = [mod(secret), ...Array.from({ length: t - 1 }, () => randomScalar())];
  return Array.from({ length: n }, (_, i) => {
    const x = BigInt(i + 1);
    return { x, y: evalPoly(coeffs, x) };
  });
}

/** Reconstruct the secret (the polynomial's value at x=0) via Lagrange interpolation. */
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

/**
 * Proactive refresh (resharing): re-randomize every share WITHOUT changing the
 * secret, by adding a fresh degree-(t-1) polynomial whose constant term is 0.
 * New shares reconstruct the same secret; a mix of old-epoch and new-epoch shares
 * does not — so an attacker must compromise `t` nodes within a single epoch.
 */
export function refresh(shares: Share[], t: number): Share[] {
  const zeroPoly = [0n, ...Array.from({ length: t - 1 }, () => randomScalar())];
  return shares.map(({ x, y }) => ({ x, y: mod(y + evalPoly(zeroPoly, x)) }));
}
