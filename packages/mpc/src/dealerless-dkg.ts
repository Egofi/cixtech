import { secp256k1 } from "@noble/curves/secp256k1";
import { evalPoly, mod, randomScalar } from "./shamir.js";
import type { KeyShare } from "./threshold-signer.js";

const Point = secp256k1.Point;

export interface DealerlessResult {
  shares: KeyShare[];
  publicKey: Uint8Array;
  /** Aggregated Feldman commitments (one per polynomial coefficient) each share verifies against. */
  commitments: Uint8Array[];
}

/**
 * Dealerless DKG with Feldman verifiable secret sharing (ADR 0007 upgrade over the
 * dealer ceremony). Each of `n` participants picks its OWN random secret + degree
 * `t-1` polynomial and publishes commitments g^coeff; every node's final share is
 * the SUM of the shares it received. The group key is Σ of the participants'
 * secrets — no single party ever chooses or sees the whole key, even at genesis.
 * Every share is verifiable against the aggregated commitments (a bad dealer is
 * detectable). Modelled in-process here; real deployment runs one participant per
 * node with an authenticated broadcast channel.
 *
 * Signing still combines shares (the interim in ADR 0014); this fixes GENESIS,
 * not the never-assembled-at-signing property — that is the audited CMP core.
 */
export function dealerlessDkg(threshold: number, n: number): DealerlessResult {
  if (threshold < 1 || threshold > n) throw new Error(`invalid threshold ${threshold} of ${n}`);

  const participants = Array.from({ length: n }, () => {
    const coeffs = [randomScalar(), ...Array.from({ length: threshold - 1 }, () => randomScalar())];
    const commitments = coeffs.map((c) => Point.BASE.multiply(c));
    return { coeffs, commitments };
  });

  // Aggregated commitment per coefficient = Σ_i C_i[k]; the group public key is agg[0] = g^(Σ secrets).
  const agg = Array.from({ length: threshold }, (_, k) => {
    let acc = Point.ZERO;
    for (const p of participants) acc = acc.add(p.commitments[k] as InstanceType<typeof Point>);
    return acc;
  });
  const publicKey = (agg[0] as InstanceType<typeof Point>).toBytes(true);
  const commitments = agg.map((c) => c.toBytes(true));

  const shares: KeyShare[] = [];
  for (let j = 1; j <= n; j++) {
    let y = 0n;
    for (const p of participants) y = mod(y + evalPoly(p.coeffs, BigInt(j)));
    shares.push({ nodeId: j, share: { x: BigInt(j), y }, publicKey, threshold });
  }
  return { shares, publicKey, commitments };
}

/**
 * Verify a share (x, y) against the aggregated Feldman commitments:
 * g^y  ==  Σ_k commitments[k] · x^k. A node checks this before trusting its share.
 */
export function verifyShare(x: bigint, y: bigint, commitments: Uint8Array[]): boolean {
  let rhs = Point.ZERO;
  let xk = 1n;
  for (const cBytes of commitments) {
    rhs = rhs.add(Point.fromBytes(cBytes).multiply(xk));
    xk = mod(xk * x);
  }
  const lhs = Point.BASE.multiply(mod(y));
  return lhs.equals(rhs);
}
