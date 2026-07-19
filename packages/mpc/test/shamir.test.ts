import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ORDER, type Share, combine, invMod, randomScalar, refresh, split } from "../src/shamir.js";

describe("Shamir sharing over the secp256k1 scalar field", () => {
  it("invMod is a true modular inverse", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 1n, max: ORDER - 1n }), (a) => {
        expect((a * invMod(a)) % ORDER).toBe(1n);
      }),
    );
  });

  it("any t shares reconstruct the secret; fewer do not", () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 6 }), fc.integer({ min: 0, max: 4 }), (t, extra) => {
        const n = t + extra;
        const secret = randomScalar();
        const shares = split(secret, t, n);

        // Every distinct t-subset recovers it exactly.
        expect(combine(shares.slice(0, t))).toBe(secret);
        expect(combine(shares.slice(n - t))).toBe(secret);
        // t-1 shares do not (they interpolate a different value at 0).
        if (t >= 2) expect(combine(shares.slice(0, t - 1))).not.toBe(secret);
      }),
    );
  });

  it("proactive refresh keeps the secret but invalidates cross-epoch mixes", () => {
    const t = 3;
    const n = 5;
    const secret = randomScalar();
    const oldShares = split(secret, t, n);
    const newShares = refresh(oldShares, t);

    // New epoch still reconstructs the same key.
    expect(combine(newShares.slice(0, t))).toBe(secret);
    // Mixing old and new epoch shares does NOT (forces same-epoch compromise).
    const mixed = [oldShares[0], oldShares[1], newShares[2]] as Share[];
    expect(combine(mixed)).not.toBe(secret);
  });
});
