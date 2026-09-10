import { POLICY_SCHEMA_SQL } from "@/schemas/sql";
import { SqlAllowlist } from "@/stores";
import type { PayoutContext, SqlClient } from "@/types";

import { freshDatabase } from "@test/support/index.js";
import { beforeEach, describe, expect, it } from "vitest";

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

let sql: SqlClient;
beforeEach(async () => {
  const db = await freshDatabase();
  await db.exec(POLICY_SCHEMA_SQL);
  sql = db.sql;
});

describe("SqlAllowlist — cool-down (§7.2)", () => {
  it("an added destination is NOT usable until its cool-down elapses", async () => {
    const list = new SqlAllowlist(sql);
    const now = new Date("2026-01-01T00:00:00Z");
    await list.add("t1", "m1", "TRON", DEST, 60 * 60_000, now);

    expect(await list.usable(ctx(), now)).toBe(false);

    expect(await list.usable(ctx(), new Date(now.getTime() + 59 * 60_000))).toBe(false);

    expect(await list.usable(ctx(), new Date(now.getTime() + 61 * 60_000))).toBe(true);
  });

  it("an unknown destination is never usable", async () => {
    const list = new SqlAllowlist(sql);
    expect(await list.usable(ctx({ destination: "TStranger" }), new Date())).toBe(false);
  });

  it("scopes by (tenant, merchant, chain) — another account can't use it", async () => {
    const list = new SqlAllowlist(sql);
    const now = new Date();
    await list.add("t1", "m1", "TRON", DEST, 0, now);
    expect(await list.usable(ctx(), now)).toBe(true);
    expect(await list.usable(ctx({ merchant: "m2" }), now)).toBe(false);
  });
});
