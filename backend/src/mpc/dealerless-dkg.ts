import type { DealerlessResult, KeyShare } from "@/types";
import { secp256k1 } from "@noble/curves/secp256k1";
import { evalPoly, mod, randomScalar } from "./shamir.js";

const Point = secp256k1.Point;

export function dealerlessDkg(threshold: number, n: number): DealerlessResult {
  if (threshold < 1 || threshold > n) throw new Error(`invalid threshold ${threshold} of ${n}`);

  const participants = Array.from({ length: n }, () => {
    const coeffs = [randomScalar(), ...Array.from({ length: threshold - 1 }, () => randomScalar())];
    const commitments = coeffs.map((c) => Point.BASE.multiply(c));
    return { coeffs, commitments };
  });

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
    shares.push({ nodeId: j, share: { x: BigInt(j), y }, publicKey, threshold, epoch: 0 });
  }
  return { shares, publicKey, commitments };
}

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
