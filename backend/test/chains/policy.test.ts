import {
  DenylistSanctionsScreener,
  FlagKillSwitch,
  InMemoryVelocityLimiter,
  PolicyEngine,
} from "@/chains/payout/policy.js";
import { PolicyDeniedError } from "@/common";
import { describe, expect, it } from "vitest";

const DEST = "TDestination0000000000000000000000";

const ctx = (over: Partial<Parameters<PolicyEngine["check"]>[0]> = {}) => ({
  tenant: "t1",
  merchant: "m1",
  chain: "TRON",
  asset: "USDT",
  amountBaseUnits: 100_000_000n,
  destination: DEST,
  ...over,
});

describe("payout policy guard — base layers", () => {
  const engine = new PolicyEngine({
    maxPerPayoutBaseUnits: 1_000_000_000n, // 1000 USDT
    allowlist: new Set([DEST]),
  });

  it("allows a positive, within-limit, allow-listed payout", async () => {
    await expect(engine.check(ctx())).resolves.toBeUndefined();
  });

  it("denies a payout over the per-payout limit", async () => {
    await expect(engine.check(ctx({ amountBaseUnits: 1_000_000_001n }))).rejects.toThrow(
      PolicyDeniedError,
    );
  });

  it("denies a payout to a non-allow-listed destination", async () => {
    await expect(engine.check(ctx({ destination: "TStranger" }))).rejects.toThrow(
      PolicyDeniedError,
    );
  });

  it("denies a non-positive amount", async () => {
    await expect(engine.check(ctx({ amountBaseUnits: 0n }))).rejects.toThrow(PolicyDeniedError);
  });
});

describe("payout policy guard — kill-switch", () => {
  it("halts every payout while engaged, resumes when reset", async () => {
    const kill = new FlagKillSwitch();
    const engine = new PolicyEngine({
      maxPerPayoutBaseUnits: 1_000_000_000n,
      allowlist: new Set([DEST]),
      killSwitch: kill,
    });

    await expect(engine.check(ctx())).resolves.toBeUndefined();
    kill.engage();
    await expect(engine.check(ctx())).rejects.toThrow(/kill-switch/);
    kill.reset();
    await expect(engine.check(ctx())).resolves.toBeUndefined();
  });
});

describe("payout policy guard — sanctions", () => {
  it("denies a sanctions-screened destination even when allow-listed", async () => {
    const engine = new PolicyEngine({
      maxPerPayoutBaseUnits: 1_000_000_000n,
      allowlist: new Set([DEST]),
      sanctions: new DenylistSanctionsScreener(new Set([DEST])),
    });
    await expect(engine.check(ctx())).rejects.toThrow(/sanctions/);
  });
});

describe("payout policy guard — velocity", () => {
  it("caps cumulative spend per merchant within the window, then frees it after", async () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const engine = new PolicyEngine({
      maxPerPayoutBaseUnits: 1_000_000_000n,
      allowlist: new Set([DEST]),
      velocity: new InMemoryVelocityLimiter({
        windowMs: 60 * 60_000, // 1h
        maxTotalBaseUnits: 250_000_000n, // 250 USDT/h
      }),
    });

    await expect(engine.check(ctx(), now)).resolves.toBeUndefined();
    await expect(engine.check(ctx(), now)).resolves.toBeUndefined();
    await expect(engine.check(ctx(), now)).rejects.toThrow(/velocity/);

    await expect(engine.check(ctx({ merchant: "m2" }), now)).resolves.toBeUndefined();

    const later = new Date(now.getTime() + 61 * 60_000);
    await expect(engine.check(ctx(), later)).resolves.toBeUndefined();
  });
});
