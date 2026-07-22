import {
  type AddressBalance,
  InsufficientPoolFundsError,
  POOL_SCHEMA_SQL,
  PoolGatherer,
  PoolManager,
  SqlPoolStore,
} from "@cixtech/attribution";
import type { SqlClient } from "@cixtech/ledger";
import { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";

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

// index → address, and each address's fake on-chain balance.
const ADDR = (i: number) => `TPool${i}`;
const BAL: Record<string, bigint> = { TPool0: 200_000n, TPool1: 300_000n, TPool2: 400_000n };
const balances: AddressBalance = {
  async balance(_c, address) {
    return BAL[address] ?? 0n;
  },
};

let gatherer: PoolGatherer;

beforeEach(async () => {
  const db = new PGlite();
  await db.exec(POOL_SCHEMA_SQL);
  const sql = wrap(db);
  let index = 0;
  const pool = new PoolManager(new SqlPoolStore(sql), () => ADDR(index++), { cooldownMs: 60_000 });
  // Three funded pool addresses for the same (tenant, merchant, chain).
  await pool.assign("t1", "m1", "TRON", "inv-0", "xpub");
  await pool.assign("t1", "m1", "TRON", "inv-1", "xpub");
  await pool.assign("t1", "m1", "TRON", "inv-2", "xpub");
  gatherer = new PoolGatherer(pool, balances);
});

describe("PoolGatherer.gather — multi-address consolidation (ADR 0009 §6.3)", () => {
  it("uses a single leg when one address covers the amount", async () => {
    const legs = await gatherer.gather("t1", "m1", "TRON", "USDT", 350_000n);
    expect(legs).toEqual([{ address: "TPool2", derivationIndex: 2, amountBaseUnits: 350_000n }]);
  });

  it("consolidates across addresses, largest-first, for the exact amount", async () => {
    const legs = await gatherer.gather("t1", "m1", "TRON", "USDT", 800_000n);
    expect(legs).toEqual([
      { address: "TPool2", derivationIndex: 2, amountBaseUnits: 400_000n },
      { address: "TPool1", derivationIndex: 1, amountBaseUnits: 300_000n },
      { address: "TPool0", derivationIndex: 0, amountBaseUnits: 100_000n },
    ]);
    expect(legs.reduce((s, l) => s + l.amountBaseUnits, 0n)).toBe(800_000n);
  });

  it("rejects — never underpays — when the merchant's total falls short", async () => {
    await expect(gatherer.gather("t1", "m1", "TRON", "USDT", 1_000_000n)).rejects.toBeInstanceOf(
      InsufficientPoolFundsError,
    );
  });
});
