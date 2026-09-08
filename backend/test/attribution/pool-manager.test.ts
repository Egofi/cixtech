import { PoolManager } from "@/attribution/pool-manager.js";
import { InvalidPoolTransitionError, PoolState } from "@/attribution/pool-state.js";
import { SqlPoolStore } from "@/attribution/sql-pool-store.js";
import type { SqlClient } from "@/ledger";
import { beforeEach, describe, expect, it } from "vitest";
import { fakeDerive, freshPool } from "./postgres.js";

const T = "t1";
const M = "m1";
const CHAIN = "TRON";
const XPUB = "xpub-test";

describe("pool address lifecycle (ADR 0009)", () => {
  let sql: SqlClient;
  let pool: PoolManager;
  let store: SqlPoolStore;

  beforeEach(async () => {
    ({ sql } = await freshPool());
    store = new SqlPoolStore(sql);
    pool = new PoolManager(store, fakeDerive, { cooldownMs: 60_000 });
  });

  it("mints a new address per invoice while all are in use", async () => {
    const a0 = await pool.assign(T, M, CHAIN, "inv-0", XPUB);
    const a1 = await pool.assign(T, M, CHAIN, "inv-1", XPUB);
    expect(a0).toBe("TRON:xpub-test:0");
    expect(a1).toBe("TRON:xpub-test:1"); // distinct — index advanced, no collision
  });

  it("reuses an AVAILABLE address instead of minting a new one", async () => {
    const a0 = await pool.assign(T, M, CHAIN, "inv-0", XPUB);
    // Take it through its full lifecycle back to AVAILABLE.
    await pool.markInUse(CHAIN, a0);
    await pool.cool(CHAIN, a0);
    await pool.release(CHAIN, a0);
    const reused = await pool.assign(T, M, CHAIN, "inv-1", XPUB);
    expect(reused).toBe(a0); // same address, reused — the pool bounds fragmentation
  });

  it("resolves an assigned address to its account, and returns null when unassigned", async () => {
    const addr = await pool.assign(T, M, CHAIN, "inv-0", XPUB);
    expect(await pool.resolve(CHAIN, addr)).toEqual({ tenant: T, merchant: M });
    expect(await pool.resolve(CHAIN, "TRON-unknown")).toBeNull();
    // After release it is AVAILABLE → no longer attributable.
    await pool.markInUse(CHAIN, addr);
    await pool.cool(CHAIN, addr);
    await pool.release(CHAIN, addr);
    expect(await pool.resolve(CHAIN, addr)).toBeNull();
  });

  it("rejects an out-of-order transition", async () => {
    const addr = await pool.assign(T, M, CHAIN, "inv-0", XPUB);
    // RESERVED → cool is invalid (must be IN_USE first).
    await expect(pool.cool(CHAIN, addr)).rejects.toBeInstanceOf(InvalidPoolTransitionError);
  });

  it("releases an unpaid reserved address (RESERVED → AVAILABLE)", async () => {
    const addr = await pool.assign(T, M, CHAIN, "inv-0", XPUB);
    await pool.release(CHAIN, addr); // invoice expired unpaid
    const reused = await pool.assign(T, M, CHAIN, "inv-1", XPUB);
    expect(reused).toBe(addr);
  });

  it("sweeps only addresses whose cool-off has elapsed", async () => {
    const addr = await pool.assign(T, M, CHAIN, "inv-0", XPUB);
    await pool.markInUse(CHAIN, addr);
    await pool.cool(CHAIN, addr); // cooldown = now + 60s

    expect(await pool.releaseCooled(new Date(Date.now() - 1_000))).toBe(0); // not yet
    const row = await store.findByAddress(CHAIN, addr);
    expect(row?.state).toBe(PoolState.Cooling);

    expect(await pool.releaseCooled(new Date(Date.now() + 120_000))).toBe(1); // elapsed
    expect((await store.findByAddress(CHAIN, addr))?.state).toBe(PoolState.Available);
  });

  it("keeps separate pools per merchant", async () => {
    // Distinct merchants have distinct xpubs → distinct addresses even at index 0.
    const a = await pool.assign(T, "m1", CHAIN, "inv-a", "xpub-m1");
    const b = await pool.assign(T, "m2", CHAIN, "inv-b", "xpub-m2");
    expect(a).not.toBe(b);
    expect(await pool.resolve(CHAIN, a)).toEqual({ tenant: T, merchant: "m1" });
    expect(await pool.resolve(CHAIN, b)).toEqual({ tenant: T, merchant: "m2" });
  });
});
