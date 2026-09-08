import type { Allowlist, PayoutContext, SolvencyOracle } from "@/chains/payout/policy.js";
import {
  ApprovalRequiredError,
  ComplianceHoldError,
  PolicyDeniedError,
  PolicyEngine,
  TimeLockedError,
} from "@/chains/payout/policy.js";
import { describe, expect, it } from "vitest";

const DEST = "TDestination0000000000000000000000";
const ctx = (over: Partial<PayoutContext> = {}): PayoutContext => ({
  tenant: "t1",
  merchant: "m1",
  chain: "TRON",
  asset: "USDT",
  amountBaseUnits: 100n,
  destination: DEST,
  ...over,
});

const solvent = (ok: boolean): SolvencyOracle => ({
  async solvent() {
    return ok;
  },
});
const alwaysUsable: Allowlist = { usable: () => true };

describe("policy — solvency gate (§7.7)", () => {
  it("denies when the invariant is not satisfied, fail-closed", async () => {
    const engine = new PolicyEngine({
      maxPerPayoutBaseUnits: 1_000n,
      allowlist: new Set([DEST]),
      solvency: solvent(false),
    });
    expect((await engine.evaluate(ctx())).type).toBe("DENY");
    await expect(engine.check(ctx())).rejects.toBeInstanceOf(PolicyDeniedError);
  });

  it("denies (not allows) when the solvency oracle is unreachable", async () => {
    const engine = new PolicyEngine({
      maxPerPayoutBaseUnits: 1_000n,
      allowlist: new Set([DEST]),
      solvency: {
        async solvent() {
          throw new Error("recon down");
        },
      },
    });
    await expect(engine.check(ctx())).rejects.toThrow(/recon down/);
  });

  it("allows when solvent", async () => {
    const engine = new PolicyEngine({
      maxPerPayoutBaseUnits: 1_000n,
      allowlist: new Set([DEST]),
      solvency: solvent(true),
    });
    expect((await engine.evaluate(ctx())).type).toBe("ALLOW");
  });
});

describe("policy — allow-list cool-down (§7.2)", () => {
  const notYet: Allowlist = { usable: () => false };

  it("denies a store address still in cool-down, even though it exists", async () => {
    const engine = new PolicyEngine({
      maxPerPayoutBaseUnits: 1_000n,
      allowlist: new Set(),
      allowlistStore: notYet,
    });
    await expect(engine.check(ctx())).rejects.toBeInstanceOf(PolicyDeniedError);
  });

  it("admits a store address past its cool-down", async () => {
    const engine = new PolicyEngine({
      maxPerPayoutBaseUnits: 1_000n,
      allowlist: new Set(),
      allowlistStore: alwaysUsable,
    });
    expect((await engine.evaluate(ctx())).type).toBe("ALLOW");
  });

  it("still admits an operator static-set address without cool-down", async () => {
    const engine = new PolicyEngine({
      maxPerPayoutBaseUnits: 1_000n,
      allowlist: new Set([DEST]),
      allowlistStore: notYet,
    });
    expect((await engine.evaluate(ctx())).type).toBe("ALLOW");
  });
});

describe("policy — dual approval + separation of duties (§7.4)", () => {
  const engine = new PolicyEngine({
    maxPerPayoutBaseUnits: 1_000_000n,
    allowlist: new Set([DEST]),
    approval: { thresholdBaseUnits: 100n, required: 2 },
  });

  it("does not require approval at or below the threshold", async () => {
    expect((await engine.evaluate(ctx({ amountBaseUnits: 100n }))).type).toBe("ALLOW");
  });

  it("requires distinct approvals above the threshold", async () => {
    const d = await engine.evaluate(ctx({ amountBaseUnits: 500n, approvals: ["alice"] }));
    expect(d).toEqual({ type: "REQUIRE_APPROVAL", needed: 2, have: 1 });
    await expect(
      engine.check(ctx({ amountBaseUnits: 500n, approvals: ["alice"] })),
    ).rejects.toBeInstanceOf(ApprovalRequiredError);
  });

  it("never counts the requester as one of its own approvers", async () => {
    const d = await engine.evaluate(
      ctx({ amountBaseUnits: 500n, requester: "alice", approvals: ["alice", "bob"] }),
    );
    expect(d).toEqual({ type: "REQUIRE_APPROVAL", needed: 2, have: 1 });
  });

  it("allows once two distinct non-requester approvals are present", async () => {
    const d = await engine.evaluate(
      ctx({ amountBaseUnits: 500n, requester: "alice", approvals: ["bob", "carol"] }),
    );
    expect(d.type).toBe("ALLOW");
  });
});

describe("policy — time-lock (§7.5)", () => {
  const engine = new PolicyEngine({
    maxPerPayoutBaseUnits: 1_000_000n,
    allowlist: new Set([DEST]),
    timeLock: { thresholdBaseUnits: 100n, delayMs: 60_000 },
  });

  it("delays a high-value payout until the cancel window elapses", async () => {
    const requestedAt = new Date("2026-01-01T00:00:00Z");
    const d = await engine.evaluate(ctx({ amountBaseUnits: 500n, requestedAt }), requestedAt);
    expect(d).toEqual({ type: "DELAY", until: new Date("2026-01-01T00:01:00Z") });
    await expect(
      engine.check(ctx({ amountBaseUnits: 500n, requestedAt }), requestedAt),
    ).rejects.toBeInstanceOf(TimeLockedError);
  });

  it("allows after the delay has elapsed", async () => {
    const requestedAt = new Date("2026-01-01T00:00:00Z");
    const later = new Date("2026-01-01T00:01:01Z");
    const d = await engine.evaluate(ctx({ amountBaseUnits: 500n, requestedAt }), later);
    expect(d.type).toBe("ALLOW");
  });
});

describe("policy — compliance hold (§7.6)", () => {
  it("HOLDs a sanctions-screened destination", async () => {
    const engine = new PolicyEngine({
      maxPerPayoutBaseUnits: 1_000n,
      allowlist: new Set([DEST]),
      sanctions: { isBlocked: () => true },
    });
    expect((await engine.evaluate(ctx())).type).toBe("HOLD");
    await expect(engine.check(ctx())).rejects.toBeInstanceOf(ComplianceHoldError);
  });
});
