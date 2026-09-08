import type { Attribution } from "@/attribution";
import type { ChainDeposit } from "@/chains/chain-adapter.js";
import { DepositIngestor, type DepositScreener } from "@/chains/ingest/deposit-ingestor.js";
import { LEDGER_SCHEMA_SQL, LedgerService, SqlLedgerStore } from "@/ledger";
import type { SqlClient } from "@/ledger";
import { Asset, LedgerAccountKey } from "@/types";
import { type TestDatabase, freshDatabase } from "@test/support/index.js";
import { beforeEach, describe, expect, it } from "vitest";

const RECIPIENT = "TRecipient000000000000000000000000";
const USDT = Asset("USDT");
const POOL = LedgerAccountKey("pool_addr:TRON:m1");
const AVAILABLE = LedgerAccountKey("merchant_available:t1:m1");
const SUSPENSE = LedgerAccountKey("compliance_suspense:t1");

const attribution: Attribution = {
  async resolve(chain, address) {
    return chain === "TRON" && address === RECIPIENT
      ? { tenant: "t1", merchant: "m1", feeBasisPoints: 50 }
      : null;
  },
};

const deposit = (over: Partial<ChainDeposit> = {}): ChainDeposit => ({
  chain: "TRON",
  txId: "tx-abc",
  index: 0,
  to: RECIPIENT,
  from: "TSender",
  asset: "USDT",
  amountBaseUnits: 1_000_000n,
  ...over,
});

let db: TestDatabase;
let ledger: LedgerService;

beforeEach(async () => {
  db = await freshDatabase();
  await db.exec(LEDGER_SCHEMA_SQL);
  ledger = new LedgerService(new SqlLedgerStore(db.sql));
});

describe("DepositIngestor — KYT quarantine (§14)", () => {
  const blockAll: DepositScreener = { screen: () => "blocked" };
  const clearAll: DepositScreener = { screen: () => "clear" };

  it("quarantines a flagged deposit to compliance_suspense, never crediting the merchant", async () => {
    const ingestor = new DepositIngestor(ledger, attribution, undefined, blockAll);
    const res = await ingestor.ingestConfirmed(deposit());
    expect(res.status).toBe("quarantined");
    expect(await ledger.availableBalance(SUSPENSE, USDT)).toBe(1_000_000n); // held
    expect(await ledger.availableBalance(AVAILABLE, USDT)).toBe(0n); // NOT credited
    expect(await ledger.getBalance(POOL, USDT)).toBe(1_000_000n); // funds physically landed
  });

  it("credits normally when the screen is clear", async () => {
    const ingestor = new DepositIngestor(ledger, attribution, undefined, clearAll);
    const res = await ingestor.ingestConfirmed(deposit());
    expect(res.status).toBe("credited");
    expect(await ledger.availableBalance(AVAILABLE, USDT)).toBe(995_000n);
    expect(await ledger.availableBalance(SUSPENSE, USDT)).toBe(0n);
  });
});

describe("DepositIngestor — reorg reversal (§9)", () => {
  it("reverses a credited deposit that reorged out, restoring every balance", async () => {
    const ingestor = new DepositIngestor(ledger, attribution);
    await ingestor.ingestConfirmed(deposit());
    expect(await ledger.availableBalance(AVAILABLE, USDT)).toBe(995_000n);

    const rev = await ingestor.reverseCredit(deposit());
    expect(rev.status).toBe("reversed");
    expect(await ledger.availableBalance(AVAILABLE, USDT)).toBe(0n);
    expect(await ledger.getBalance(POOL, USDT)).toBe(0n);
  });

  it("is idempotent — a redelivered reorg signal reverses exactly once", async () => {
    const ingestor = new DepositIngestor(ledger, attribution);
    await ingestor.ingestConfirmed(deposit());
    await ingestor.reverseCredit(deposit());
    await ingestor.reverseCredit(deposit()); // second reversal must be a no-op
    expect(await ledger.getBalance(POOL, USDT)).toBe(0n); // not double-reversed into negative
  });

  it("is a no-op for a deposit that was never credited", async () => {
    const ingestor = new DepositIngestor(ledger, attribution);
    const rev = await ingestor.reverseCredit(deposit({ to: "TUnknown" }));
    expect(rev.status).toBe("not-found");
  });
});
