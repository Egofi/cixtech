import type { PayoutBroadcaster } from "@/chains/payout/broadcaster.js";
import { LEDGER_SCHEMA_SQL } from "@/schemas/sql";
import { LedgerService, PayoutService } from "@/services";
import { SqlLedgerStore } from "@/stores";

import { PolicyEngine } from "@/chains/payout/policy.js";
import { InsufficientFundsError, PolicyDeniedError } from "@/common";
import { depositFinalized, splitFee } from "@/ledger";

import {
  Asset,
  type BroadcastResult,
  IdempotencyKey,
  JournalEntryId,
  LedgerAccountKey,
  type PayoutRequest,
  type SqlClient,
} from "@/types";
import { freshDatabase } from "@test/support/index.js";
import { describe, expect, it } from "vitest";
import { fundedGatherer } from "./pool-fixture.js";

const USDT = Asset("USDT");
const AVAILABLE = LedgerAccountKey("merchant_available:t1:m1");
const PENDING = LedgerAccountKey("merchant_pending_withdrawal:t1:m1");
const POOL = LedgerAccountKey("pool_addr:TRON:m1");
const DEST = "TDestination0000000000000000000000";
const FROM = "TPool00000000000000000000000000000";

class FakeBroadcaster implements PayoutBroadcaster {
  sent: PayoutRequest[] = [];
  async send(req: PayoutRequest): Promise<BroadcastResult> {
    this.sent.push(req);
    return { txId: `tx-${this.sent.length}` };
  }
}

const policy = new PolicyEngine({
  maxPerPayoutBaseUnits: 1_000_000_000n,
  allowlist: new Set([DEST]),
});

async function makeService(grossDeposit: bigint) {
  const db = await freshDatabase();
  await db.exec(LEDGER_SCHEMA_SQL);
  const sql = db.sql;
  const ledger = new LedgerService(new SqlLedgerStore(sql));
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
  const gatherer = await fundedGatherer(db, sql, {
    tenant: "t1",
    merchant: "m1",
    chain: "TRON",
    address: FROM,
  });
  const broadcaster = new FakeBroadcaster();
  return { ledger, broadcaster, service: new PayoutService(ledger, policy, broadcaster, gatherer) };
}

const params = (amount: bigint, over = {}) => ({
  tenant: "t1",
  merchant: "m1",
  chain: "TRON",
  asset: "USDT",
  amountBaseUnits: amount,
  destination: DEST,
  idempotencyKey: `pay-${amount}`,
  ...over,
});

describe("PayoutService (policy → lock → broadcast → settle)", () => {
  it("moves funds available → pending → out of the pool on a successful payout", async () => {
    const { ledger, service, broadcaster } = await makeService(1_000_000n);

    const res = await service.payout(params(500_000n));
    expect(res).toEqual({ txId: "tx-1", status: "settled", from: FROM });
    expect(broadcaster.sent[0]).toMatchObject({
      toAddress: DEST,
      fromAddress: FROM,
      fromDerivationIndex: 0,
      amountBaseUnits: 500_000n,
    });

    const { net } = splitFee(1_000_000n, 50);
    expect(await ledger.availableBalance(AVAILABLE, USDT)).toBe(net - 500_000n);
    expect(await ledger.availableBalance(PENDING, USDT)).toBe(0n);
    expect(await ledger.getBalance(POOL, USDT)).toBe(1_000_000n - 500_000n);
  });

  it("rejects an over-limit payout before touching the ledger or broadcasting", async () => {
    const { ledger, service, broadcaster } = await makeService(2_000_000_000n);
    await expect(service.payout(params(1_000_000_001n))).rejects.toBeInstanceOf(PolicyDeniedError);
    expect(broadcaster.sent).toHaveLength(0);
    expect(await ledger.availableBalance(PENDING, USDT)).toBe(0n);
  });

  it("rejects a non-allow-listed destination", async () => {
    const { service, broadcaster } = await makeService(1_000_000n);
    await expect(
      service.payout(params(100_000n, { destination: "TStranger" })),
    ).rejects.toBeInstanceOf(PolicyDeniedError);
    expect(broadcaster.sent).toHaveLength(0);
  });

  it("rejects a payout exceeding available balance and never broadcasts", async () => {
    const { service, broadcaster } = await makeService(1_000_000n);
    await expect(service.payout(params(999_999n))).rejects.toBeInstanceOf(InsufficientFundsError);
    expect(broadcaster.sent).toHaveLength(0);
  });
});
