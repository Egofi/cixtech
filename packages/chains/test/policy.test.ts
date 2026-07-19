import { describe, expect, it } from "vitest";
import { PolicyDeniedError, PolicyEngine } from "../src/payout/policy.js";

const DEST = "TDestination0000000000000000000000";
const engine = new PolicyEngine({
  maxPerPayoutBaseUnits: 1_000_000_000n, // 1000 USDT
  allowlist: new Set([DEST]),
});

const ctx = (over: Partial<Parameters<PolicyEngine["check"]>[0]> = {}) => ({
  tenant: "t1",
  merchant: "m1",
  chain: "TRON",
  asset: "USDT",
  amountBaseUnits: 100_000_000n,
  destination: DEST,
  ...over,
});

describe("payout policy guard", () => {
  it("allows a positive, within-limit, allow-listed payout", () => {
    expect(() => engine.check(ctx())).not.toThrow();
  });

  it("denies a payout over the per-payout limit", () => {
    expect(() => engine.check(ctx({ amountBaseUnits: 1_000_000_001n }))).toThrow(PolicyDeniedError);
  });

  it("denies a payout to a non-allow-listed destination", () => {
    expect(() => engine.check(ctx({ destination: "TStranger" }))).toThrow(PolicyDeniedError);
  });

  it("denies a non-positive amount", () => {
    expect(() => engine.check(ctx({ amountBaseUnits: 0n }))).toThrow(PolicyDeniedError);
  });
});
