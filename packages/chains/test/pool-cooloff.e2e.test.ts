import {
  POOL_SCHEMA_SQL,
  PoolManager,
  PoolState,
  PooledAttribution,
  SqlPoolStore,
} from "@cixtech/attribution";
import { LEDGER_SCHEMA_SQL, LedgerService, SqlLedgerStore } from "@cixtech/ledger";
import { freshDatabase } from "@cixtech/testing";
import { describe, expect, it } from "vitest";
import type { ChainDeposit } from "../src/chain-adapter.js";
import { DepositIngestor } from "../src/ingest/deposit-ingestor.js";

const T = "t1";
const M = "m1";
const CHAIN = "TRON";
const COOLDOWN_MS = 60_000;

async function harness() {
  const db = await freshDatabase([LEDGER_SCHEMA_SQL, POOL_SCHEMA_SQL].join("\n"));
  const ledger = new LedgerService(new SqlLedgerStore(db.sql));
  const store = new SqlPoolStore(db.sql);
  const pool = new PoolManager(store, (_c, _x, i) => `TPool${i}`, { cooldownMs: COOLDOWN_MS });
  const ingestor = new DepositIngestor(ledger, new PooledAttribution(pool, () => 50), pool);
  return { db, pool, store, ingestor };
}

const deposit = (to: string, txId: string): ChainDeposit => ({
  chain: CHAIN,
  txId,
  index: 0,
  to,
  from: "TSender",
  asset: "USDT",
  amountBaseUnits: 1_000_000n,
});

describe("pool cool-off lifecycle (ADR 0009)", () => {
  it("walks RESERVED → IN_USE → COOLING → AVAILABLE and reuses the address", async () => {
    const { pool, store, ingestor } = await harness();

    const address = await pool.assign(T, M, CHAIN, "inv-1", "xpub");
    expect((await store.findByAddress(CHAIN, address))?.state).toBe(PoolState.Reserved);

    // Crediting happens at finality, so that is where cool-off starts.
    expect((await ingestor.ingestConfirmed(deposit(address, "tx-1"))).status).toBe("credited");
    const cooling = await store.findByAddress(CHAIN, address);
    expect(cooling?.state).toBe(PoolState.Cooling);
    expect(cooling?.cooldownUntil).toBeInstanceOf(Date);

    // Still cooling → not yet reusable.
    expect(await pool.releaseCooled(new Date(Date.now() - 1_000))).toBe(0);
    expect(await pool.assign(T, M, CHAIN, "inv-2", "xpub")).not.toBe(address);

    // Cool-off elapsed → back in the pool, and reused rather than minting anew.
    expect(await pool.releaseCooled(new Date(Date.now() + COOLDOWN_MS + 1_000))).toBe(1);
    expect((await store.findByAddress(CHAIN, address))?.state).toBe(PoolState.Available);
    expect(await pool.assign(T, M, CHAIN, "inv-3", "xpub")).toBe(address);
  });

  /**
   * ADR 0009's load-bearing claim: "500 deposits across a 10-address pool
   * accumulate into 10 addresses, not 500." That only holds if cooled addresses
   * are actually returned — otherwise every assignment mints a fresh index and
   * payout gather cost scales with deposit count instead of pool size.
   */
  it("keeps the pool bounded across many sequential deposits", async () => {
    const { pool, ingestor } = await harness();

    for (let i = 0; i < 12; i++) {
      const address = await pool.assign(T, M, CHAIN, `inv-${i}`, "xpub");
      await ingestor.ingestConfirmed(deposit(address, `tx-${i}`));
      await pool.releaseCooled(new Date(Date.now() + COOLDOWN_MS + 1_000));
    }

    const addresses = await pool.addressesForMerchant(T, M, CHAIN);
    expect(addresses).toHaveLength(1); // reused every time, not 12 fresh indices
  });

  it("holds a quarantined deposit's address IN_USE — never reassigned while under review", async () => {
    const db = await freshDatabase([LEDGER_SCHEMA_SQL, POOL_SCHEMA_SQL].join("\n"));
    const ledger = new LedgerService(new SqlLedgerStore(db.sql));
    const store = new SqlPoolStore(db.sql);
    const pool = new PoolManager(store, (_c, _x, i) => `TPool${i}`, { cooldownMs: COOLDOWN_MS });
    const ingestor = new DepositIngestor(ledger, new PooledAttribution(pool, () => 50), pool, {
      screen: () => "blocked",
    });

    const address = await pool.assign(T, M, CHAIN, "inv-1", "xpub");
    expect((await ingestor.ingestConfirmed(deposit(address, "tx-1"))).status).toBe("quarantined");

    expect((await store.findByAddress(CHAIN, address))?.state).toBe(PoolState.InUse);
    // A sweep must not hand a held address to the next invoice.
    expect(await pool.releaseCooled(new Date(Date.now() + COOLDOWN_MS * 10))).toBe(0);
  });
});
