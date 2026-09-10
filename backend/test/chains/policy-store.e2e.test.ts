import { POLICY_SCHEMA_SQL } from "@/schemas/sql";
import { SqlKillSwitch, SqlVelocityLimiter } from "@/stores";
import type { PayoutContext, SqlClient } from "@/types";

import { PolicyEngine } from "@/chains/payout/policy.js";
import { PolicyDeniedError } from "@/common";

import { type TestDatabase, freshDatabase } from "@test/support/index.js";
import { beforeEach, describe, expect, it } from "vitest";

const DEST = "TDestination0000000000000000000000";
const ctx = (over: Partial<PayoutContext> = {}): PayoutContext => ({
  tenant: "t1",
  merchant: "m1",
  chain: "TRON",
  asset: "USDT",
  amountBaseUnits: 100_000_000n,
  destination: DEST,
  ...over,
});

let db: TestDatabase;
let sql: SqlClient;

beforeEach(async () => {
  db = await freshDatabase();
  await db.exec(POLICY_SCHEMA_SQL);
  sql = db.sql;
});

describe("SqlKillSwitch (durable)", () => {
  it("defaults to not-engaged, halts when engaged, resumes on reset", async () => {
    const kill = new SqlKillSwitch(sql);
    expect(await kill.engaged(ctx())).toBe(false);

    await kill.engage("incident-123");
    expect(await kill.engaged(ctx())).toBe(true);

    await kill.reset();
    expect(await kill.engaged(ctx())).toBe(false);
  });

  it("a fresh instance on the same store sees the engaged state (survives restart)", async () => {
    await new SqlKillSwitch(sql).engage("halt");

    expect(await new SqlKillSwitch(sql).engaged(ctx())).toBe(true);
  });

  it("blocks a payout through the PolicyEngine while engaged", async () => {
    const kill = new SqlKillSwitch(sql);
    const engine = new PolicyEngine({
      maxPerPayoutBaseUnits: 1_000_000_000n,
      allowlist: new Set([DEST]),
      killSwitch: kill,
    });
    await expect(engine.check(ctx())).resolves.toBeUndefined();
    await kill.engage("halt");
    await expect(engine.check(ctx())).rejects.toThrow(/kill-switch/);
  });
});

describe("SqlVelocityLimiter (durable)", () => {
  const config = { windowMs: 60 * 60_000, maxTotalBaseUnits: 250_000_000n };

  it("caps cumulative spend within the window, per merchant, and frees it after", async () => {
    const limiter = new SqlVelocityLimiter(sql, config);
    const now = new Date("2026-01-01T00:00:00Z");

    await expect(limiter.admit(ctx(), now)).resolves.toBeUndefined();
    await expect(limiter.admit(ctx(), now)).resolves.toBeUndefined();
    await expect(limiter.admit(ctx(), now)).rejects.toThrow(PolicyDeniedError);

    await expect(limiter.admit(ctx({ merchant: "m2" }), now)).resolves.toBeUndefined();

    const later = new Date(now.getTime() + 61 * 60_000);
    await expect(limiter.admit(ctx(), later)).resolves.toBeUndefined();
  });

  it("state is shared across instances (survives restart)", async () => {
    const now = new Date("2026-02-01T00:00:00Z");
    await new SqlVelocityLimiter(sql, config).admit(ctx({ amountBaseUnits: 200_000_000n }), now);

    await expect(
      new SqlVelocityLimiter(sql, config).admit(ctx({ amountBaseUnits: 100_000_000n }), now),
    ).rejects.toThrow(PolicyDeniedError);
  });
});
