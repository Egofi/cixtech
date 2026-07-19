import {
  POOL_SCHEMA_SQL,
  PoolManager,
  PoolState,
  PooledAttribution,
  SqlPoolStore,
} from "@cixtech/attribution";
import { LEDGER_SCHEMA_SQL, LedgerService, SqlLedgerStore, splitFee } from "@cixtech/ledger";
import type { SqlClient } from "@cixtech/ledger";
import { Asset, LedgerAccountKey } from "@cixtech/types";
import { PGlite } from "@electric-sql/pglite";
import { HDKey } from "@scure/bip32";
import { describe, expect, it } from "vitest";
import type { ChainDeposit } from "../src/chain-adapter.js";
import { DepositIngestor } from "../src/ingest/deposit-ingestor.js";
import { deriveTronAddress } from "../src/tron/address.js";

const USDT = Asset("USDT");
const AVAILABLE = LedgerAccountKey("merchant_available:t1:m1");
const FEE = LedgerAccountKey("egofi_fee_revenue:t1");

const seed = Uint8Array.from(Buffer.from("000102030405060708090a0b0c0d0e0f", "hex"));
const XPUB = HDKey.fromMasterSeed(seed).derive("m/44'/195'/0'").publicExtendedKey;

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

async function setup() {
  const db = new PGlite();
  await db.exec(LEDGER_SCHEMA_SQL);
  await db.exec(POOL_SCHEMA_SQL);
  const sql = wrap(db);
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
  it("assigns a real derived address, credits a deposit to it, and marks it IN_USE", async () => {
    const { ledger, pool, store, ingestor } = await setup();
    const addr = await pool.assign("t1", "m1", "TRON", "inv-1", XPUB);
    expect(addr.startsWith("T")).toBe(true); // a real base58 Tron address

    expect((await ingestor.ingestConfirmed(deposit(addr, "tx1", "1000000"))).status).toBe(
      "credited",
    );

    const { net, fee } = splitFee(1_000_000n, 50);
    expect(await ledger.availableBalance(AVAILABLE, USDT)).toBe(net);
    expect(await ledger.availableBalance(FEE, USDT)).toBe(fee);
    expect((await store.findByAddress("TRON", addr))?.state).toBe(PoolState.InUse);
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
    expect(second).toBe(first); // one address, reused — bounded fragmentation (ADR 0009)
  });
});
