import { PoolManager, PoolState, PooledAttribution } from "@/attribution";

import { DepositIngestor } from "@/chains/ingest/deposit-ingestor.js";
import { deriveTronAddress } from "@/chains/tron/address.js";
import { splitFee } from "@/ledger";
import { LEDGER_SCHEMA_SQL, POOL_SCHEMA_SQL } from "@/schemas/sql";
import { LedgerService } from "@/services";
import { SqlLedgerStore, SqlPoolStore } from "@/stores";

import { Asset, type ChainDeposit, LedgerAccountKey, type SqlClient } from "@/types";
import { HDKey } from "@scure/bip32";
import { freshDatabase } from "@test/support/index.js";
import { describe, expect, it } from "vitest";

const USDT = Asset("USDT");
const AVAILABLE = LedgerAccountKey("merchant_available:t1:m1");
const FEE = LedgerAccountKey("egofi_fee_revenue:t1");

const seed = Uint8Array.from(Buffer.from("000102030405060708090a0b0c0d0e0f", "hex"));
const XPUB = HDKey.fromMasterSeed(seed).derive("m/44'/195'/0'").publicExtendedKey;

async function setup() {
  const db = await freshDatabase();
  await db.exec(LEDGER_SCHEMA_SQL);
  await db.exec(POOL_SCHEMA_SQL);
  const sql = db.sql;
  const ledger = new LedgerService(new SqlLedgerStore(sql));
  const store = new SqlPoolStore(sql);
  const pool = new PoolManager(store, (_chain, xpub, i) => deriveTronAddress(xpub, i), {
    cooldownMs: 60_000,
  });
  const ingestor = new DepositIngestor(ledger, new PooledAttribution(pool, () => 50), pool);
  return { ledger, pool, store, ingestor };
}

const deposit = (to: string, txId: string, value: string): ChainDeposit => ({
  chain: "TRON",
  txId,
  index: 0,
  to,
  from: "TSender",
  asset: "USDT",
  amountBaseUnits: BigInt(value),
});

describe("pooled-address money-in (real Tron derivation)", () => {
  it("assigns a real derived address, credits a deposit to it, and starts its cool-off", async () => {
    const { ledger, pool, store, ingestor } = await setup();
    const addr = await pool.assign("t1", "m1", "TRON", "inv-1", XPUB);
    expect(addr.startsWith("T")).toBe(true);

    expect((await ingestor.ingestConfirmed(deposit(addr, "tx1", "1000000"))).status).toBe(
      "credited",
    );

    const { net, fee } = splitFee(1_000_000n, 50);
    expect(await ledger.availableBalance(AVAILABLE, USDT)).toBe(net);
    expect(await ledger.availableBalance(FEE, USDT)).toBe(fee);

    const credited = await store.findByAddress("TRON", addr);
    expect(credited?.state).toBe(PoolState.Cooling);
    expect(credited?.cooldownUntil).toBeInstanceOf(Date);
  });

  it("does not credit a deposit to an address that was never assigned", async () => {
    const { ingestor } = await setup();
    const res = await ingestor.ingestConfirmed(deposit("TunknownNeverAssigned", "tx2", "500000"));
    expect(res.status).toBe("unmatched");
  });

  it("reuses the address for the next invoice once it has cooled off", async () => {
    const { pool } = await setup();
    const first = await pool.assign("t1", "m1", "TRON", "inv-1", XPUB);
    await pool.markInUse("TRON", first);
    await pool.cool("TRON", first);
    await pool.releaseCooled(new Date(Date.now() + 120_000));

    const second = await pool.assign("t1", "m1", "TRON", "inv-2", XPUB);
    expect(second).toBe(first);
  });
});
