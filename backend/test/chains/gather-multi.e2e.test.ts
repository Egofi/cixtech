import type { AddressBalance } from "@/attribution";
import { PoolGatherer, PoolManager } from "@/attribution";
import { InsufficientPoolFundsError } from "@/common";
import { POOL_SCHEMA_SQL } from "@/schemas/sql";
import { SqlPoolStore } from "@/stores";
import type { SqlClient } from "@/types";

import { freshDatabase } from "@test/support/index.js";
import { beforeEach, describe, expect, it } from "vitest";

const ADDR = (i: number) => `TPool${i}`;
const BAL: Record<string, bigint> = { TPool0: 200_000n, TPool1: 300_000n, TPool2: 400_000n };
const balances: AddressBalance = {
  async balance(_c, address) {
    return BAL[address] ?? 0n;
  },
};

let gatherer: PoolGatherer;

beforeEach(async () => {
  const db = await freshDatabase();
  await db.exec(POOL_SCHEMA_SQL);
  const sql = db.sql;
  let index = 0;
  const pool = new PoolManager(new SqlPoolStore(sql), () => ADDR(index++), { cooldownMs: 60_000 });

  await pool.assign("t1", "m1", "TRON", "inv-0", "xpub");
  await pool.assign("t1", "m1", "TRON", "inv-1", "xpub");
  await pool.assign("t1", "m1", "TRON", "inv-2", "xpub");
  gatherer = new PoolGatherer(pool, balances);
});

describe("PoolGatherer.gather — multi-address consolidation (ADR 0009 §6.3)", () => {
  it("uses a single leg when one address covers the amount", async () => {
    const legs = await gatherer.gather("t1", "m1", "TRON", "USDT", 350_000n);

    expect(legs).toEqual([
      {
        address: "TPool2",
        derivationIndex: 2,
        gatherStrategy: "EOA_FUND_TRANSFER",
        amountBaseUnits: 350_000n,
      },
    ]);
  });

  it("consolidates across addresses, largest-first, for the exact amount", async () => {
    const legs = await gatherer.gather("t1", "m1", "TRON", "USDT", 800_000n);
    const EOA = "EOA_FUND_TRANSFER";
    expect(legs).toEqual([
      { address: "TPool2", derivationIndex: 2, gatherStrategy: EOA, amountBaseUnits: 400_000n },
      { address: "TPool1", derivationIndex: 1, gatherStrategy: EOA, amountBaseUnits: 300_000n },
      { address: "TPool0", derivationIndex: 0, gatherStrategy: EOA, amountBaseUnits: 100_000n },
    ]);
    expect(legs.reduce((s, l) => s + l.amountBaseUnits, 0n)).toBe(800_000n);
  });

  it("rejects — never underpays — when the merchant's total falls short", async () => {
    await expect(gatherer.gather("t1", "m1", "TRON", "USDT", 1_000_000n)).rejects.toBeInstanceOf(
      InsufficientPoolFundsError,
    );
  });
});
