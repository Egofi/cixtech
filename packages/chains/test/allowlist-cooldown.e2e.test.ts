import type { SqlClient } from "@cixtech/ledger";
import { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { POLICY_SCHEMA_SQL, SqlAllowlist } from "../src/payout/policy-store.js";
import type { PayoutContext } from "../src/payout/policy.js";

function wrap(db: PGlite): SqlClient {
  const w = (q: { query: PGlite["query"]; transaction: PGlite["transaction"] }): SqlClient => ({
    async query<R>(text: string, params?: readonly unknown[]) {
      const r = await q.query(text, params ? [...params] : []);
      return { rows: r.rows as R[] };
    },
    async transaction<T>(fn: (tx: SqlClient) => Promise<T>) {
      return q.transaction((tx) => fn(w(tx as unknown as typeof q)));
    },
  });
  return w(db);
}

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
  const db = new PGlite();
  await db.exec(POLICY_SCHEMA_SQL);
  sql = wrap(db);
});

describe("SqlAllowlist — cool-down (§7.2)", () => {
  it("an added destination is NOT usable until its cool-down elapses", async () => {
    const list = new SqlAllowlist(sql);
    const now = new Date("2026-01-01T00:00:00Z");
    await list.add("t1", "m1", "TRON", DEST, 60 * 60_000, now); // 1h cool-down

    // Same session: still cooling → not usable (defeats add-and-drain).
    expect(await list.usable(ctx(), now)).toBe(false);
    // 59 min later: still cooling.
    expect(await list.usable(ctx(), new Date(now.getTime() + 59 * 60_000))).toBe(false);
    // 61 min later: usable.
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
