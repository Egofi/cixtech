import { POOL_SCHEMA_SQL, PoolGatherer, PoolManager, SqlPoolStore } from "@/attribution";
import type { AddressBalance } from "@/attribution";
import type {
  BroadcastResult,
  PayoutBroadcaster,
  PayoutRequest,
} from "@/chains/payout/broadcaster.js";
import { PAYOUT_JOURNAL_SCHEMA_SQL, PayoutJournal } from "@/chains/payout/payout-journal.js";
import { PayoutService } from "@/chains/payout/payout-service.js";
import { PolicyEngine } from "@/chains/payout/policy.js";
import { LEDGER_SCHEMA_SQL, LedgerService, SqlLedgerStore, depositFinalized } from "@/ledger";
import type { SqlClient } from "@/ledger";
import { Asset, IdempotencyKey, JournalEntryId, LedgerAccountKey } from "@/types";
import { type TestDatabase, freshDatabase } from "@test/support/index.js";
import { beforeEach, describe, expect, it } from "vitest";

const USDT = Asset("USDT");
const DEST = "TDestination0000000000000000000000";
const AVAILABLE = LedgerAccountKey("merchant_available:t1:m1");
const POOL = LedgerAccountKey("pool_addr:TRON:m1");

/** Idempotent broadcaster: one on-chain tx per idempotency key, ever. Counts REAL sends. */
class IdempotentBroadcaster implements PayoutBroadcaster {
  realSends = 0;
  private byKey = new Map<string, string>();
  async send(req: PayoutRequest): Promise<BroadcastResult> {
    const key = req.idempotencyKey ?? `${req.fromAddress}:${req.toAddress}:${req.amountBaseUnits}`;
    const existing = this.byKey.get(key);
    if (existing) return { txId: existing };
    this.realSends++;
    const txId = `chain-tx-${this.realSends}`;
    this.byKey.set(key, txId);
    return { txId };
  }
}

const policy = new PolicyEngine({ maxPerPayoutBaseUnits: 10n ** 18n, allowlist: new Set([DEST]) });

let db: TestDatabase;
let sql: SqlClient;
let ledger: LedgerService;
let journal: PayoutJournal;
let broadcaster: IdempotentBroadcaster;
let service: PayoutService;

async function fundAddress(address: string, index: number): Promise<PoolManager> {
  const pool = new PoolManager(new SqlPoolStore(sql), () => address, { cooldownMs: 60_000 });
  await pool.assign("t1", "m1", "TRON", `invoice-${index}`, "xpub");
  return pool;
}

beforeEach(async () => {
  db = await freshDatabase();
  await db.exec(LEDGER_SCHEMA_SQL);
  await db.exec(POOL_SCHEMA_SQL);
  await db.exec(PAYOUT_JOURNAL_SCHEMA_SQL);
  sql = db.sql;
  ledger = new LedgerService(new SqlLedgerStore(sql));
  await ledger.post(
    depositFinalized({
      id: JournalEntryId("dep"),
      idempotencyKey: IdempotencyKey("dep"),
      asset: USDT,
      amount: 1_000_000n,
      feeBasisPoints: 0,
      poolAddr: POOL,
      merchantAvailable: AVAILABLE,
      feeRevenue: LedgerAccountKey("egofi_fee_revenue:t1"),
    }),
  );
  const pool = await fundAddress("TPoolA", 0);
  const balances: AddressBalance = {
    async balance() {
      return 10n ** 30n;
    },
  };
  journal = new PayoutJournal(sql);
  broadcaster = new IdempotentBroadcaster();
  service = new PayoutService(ledger, policy, broadcaster, new PoolGatherer(pool, balances), {
    journal,
  });
});

const params = (over = {}) => ({
  tenant: "t1",
  merchant: "m1",
  chain: "TRON",
  asset: "USDT",
  amountBaseUnits: 500_000n,
  destination: DEST,
  idempotencyKey: "pay-1",
  ...over,
});

describe("PayoutService durable intent journal — no double-spend", () => {
  it("settles once and records a settled intent", async () => {
    const res = await service.payout(params());
    expect(res.status).toBe("settled");
    expect(broadcaster.realSends).toBe(1);
    const intent = await journal.load("pay-1");
    expect(intent?.status).toBe("settled");
    expect(await ledger.getBalance(POOL, USDT)).toBe(500_000n); // 1,000,000 − 500,000 left the pool
  });

  it("a full replay of the same idempotency key never re-broadcasts", async () => {
    const first = await service.payout(params());
    const second = await service.payout(params());
    expect(second).toEqual(first);
    expect(broadcaster.realSends).toBe(1); // NOT 2
    // Ledger unchanged by the replay (no second lock/settle).
    expect(await ledger.getBalance(POOL, USDT)).toBe(500_000n);
  });

  it("resumes a crashed payout (broadcast recorded, settle never ran) without re-sending", async () => {
    // Simulate a crash AFTER broadcast but BEFORE settle: intent left in 'broadcast'.
    await journal.begin({
      idempotencyKey: "pay-1",
      tenant: "t1",
      merchant: "m1",
      chain: "TRON",
      asset: "USDT",
      amountBaseUnits: 500_000n,
      destination: DEST,
    });
    await journal.setFrom("pay-1", "TPoolA");
    // Pretend the on-chain tx already went out under this key.
    await broadcaster.send({
      chain: "TRON",
      asset: "USDT",
      amountBaseUnits: 500_000n,
      fromAddress: "TPoolA",
      fromDerivationIndex: 0,
      toAddress: DEST,
      idempotencyKey: "pay-1",
    });
    await journal.markBroadcast("pay-1", "chain-tx-1");
    const before = broadcaster.realSends; // 1

    const res = await service.payout(params());
    expect(res).toMatchObject({ txId: "chain-tx-1", status: "settled", from: "TPoolA" });
    expect(broadcaster.realSends).toBe(before); // resume did NOT broadcast again
    expect((await journal.load("pay-1"))?.status).toBe("settled");
  });
});
