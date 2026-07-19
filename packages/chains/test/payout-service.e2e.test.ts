import {
  LEDGER_SCHEMA_SQL,
  LedgerService,
  SqlLedgerStore,
  depositFinalized,
  splitFee,
} from "@cixtech/ledger";
import type { SqlClient } from "@cixtech/ledger";
import { InsufficientFundsError } from "@cixtech/ledger";
import { Asset, IdempotencyKey, JournalEntryId, LedgerAccountKey } from "@cixtech/types";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import type {
  BroadcastResult,
  PayoutBroadcaster,
  PayoutRequest,
} from "../src/payout/broadcaster.js";
import { PayoutService } from "../src/payout/payout-service.js";
import { PolicyDeniedError, PolicyEngine } from "../src/payout/policy.js";

const USDT = Asset("USDT");
const AVAILABLE = LedgerAccountKey("merchant_available:t1:m1");
const PENDING = LedgerAccountKey("merchant_pending_withdrawal:t1:m1");
const POOL = LedgerAccountKey("pool_addr:TRON:m1");
const DEST = "TDestination0000000000000000000000";
const FROM = "TPool00000000000000000000000000000";

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

/** Fake broadcaster: records the request and returns a txId — no network, no funded key. */
class FakeBroadcaster implements PayoutBroadcaster {
  sent: PayoutRequest[] = [];
  async send(req: PayoutRequest): Promise<BroadcastResult> {
    this.sent.push(req);
    return { txId: `tx-${this.sent.length}` };
  }
}

async function fundedLedger(grossDeposit: bigint) {
  const db = new PGlite();
  await db.exec(LEDGER_SCHEMA_SQL);
  const ledger = new LedgerService(new SqlLedgerStore(wrap(db)));
  await ledger.post(
    depositFinalized({
      id: JournalEntryId("dep"),
      idempotencyKey: IdempotencyKey("dep"),
      asset: USDT,
      amount: grossDeposit,
      feeBasisPoints: 50,
      poolAddr: POOL,
      merchantAvailable: AVAILABLE,
      feeRevenue: LedgerAccountKey("egofi_fee_revenue:t1"),
    }),
  );
  return ledger;
}

const policy = new PolicyEngine({
  maxPerPayoutBaseUnits: 1_000_000_000n,
  allowlist: new Set([DEST]),
});

function makeService(ledger: LedgerService) {
  const broadcaster = new FakeBroadcaster();
  return { broadcaster, service: new PayoutService(ledger, policy, broadcaster) };
}

const params = (amount: bigint, over = {}) => ({
  tenant: "t1",
  merchant: "m1",
  chain: "TRON",
  asset: "USDT",
  amountBaseUnits: amount,
  destination: DEST,
  fromAddress: FROM,
  idempotencyKey: `pay-${amount}`,
  ...over,
});

describe("PayoutService (policy → lock → broadcast → settle)", () => {
  it("moves funds available → pending → out of the pool on a successful payout", async () => {
    const ledger = await fundedLedger(1_000_000n); // available = 995000
    const { service, broadcaster } = makeService(ledger);

    const res = await service.payout(params(500_000n));
    expect(res).toEqual({ txId: "tx-1", status: "settled" });
    expect(broadcaster.sent[0]).toMatchObject({ toAddress: DEST, amountBaseUnits: 500_000n });

    const { net } = splitFee(1_000_000n, 50);
    expect(await ledger.availableBalance(AVAILABLE, USDT)).toBe(net - 500_000n); // debited
    expect(await ledger.availableBalance(PENDING, USDT)).toBe(0n); // settled, not stuck
    expect(await ledger.getBalance(POOL, USDT)).toBe(1_000_000n - 500_000n); // left the pool
  });

  it("rejects an over-limit payout before touching the ledger or broadcasting", async () => {
    const ledger = await fundedLedger(2_000_000_000n);
    const { service, broadcaster } = makeService(ledger);
    await expect(service.payout(params(1_000_000_001n))).rejects.toBeInstanceOf(PolicyDeniedError);
    expect(broadcaster.sent).toHaveLength(0);
    expect(await ledger.availableBalance(PENDING, USDT)).toBe(0n);
  });

  it("rejects a non-allow-listed destination", async () => {
    const ledger = await fundedLedger(1_000_000n);
    const { service, broadcaster } = makeService(ledger);
    await expect(
      service.payout(params(100_000n, { destination: "TStranger" })),
    ).rejects.toBeInstanceOf(PolicyDeniedError);
    expect(broadcaster.sent).toHaveLength(0);
  });

  it("rejects a payout exceeding available balance and never broadcasts", async () => {
    const ledger = await fundedLedger(1_000_000n); // available 995000
    const { service, broadcaster } = makeService(ledger);
    await expect(service.payout(params(999_999n))).rejects.toBeInstanceOf(InsufficientFundsError);
    expect(broadcaster.sent).toHaveLength(0); // guard + lock happen before broadcast
  });
});
