import { type AddressBalance, PoolManager } from "@/attribution";
import { ExternalReconciler } from "@/chains/reconcile/external-reconciler.js";
import { FeeSweepPlanner } from "@/chains/treasury/fee-sweep-planner.js";
import { depositFinalized } from "@/ledger";
import { LEDGER_SCHEMA_SQL, POOL_SCHEMA_SQL } from "@/schemas/sql";
import { LedgerService } from "@/services";
import { SqlLedgerStore, SqlPoolStore } from "@/stores";

import { Asset, IdempotencyKey, JournalEntryId, LedgerAccountKey, type SqlClient } from "@/types";
import { freshDatabase } from "@test/support/index.js";
import { beforeEach, describe, expect, it } from "vitest";

const ADDR = (i: number) => `TPool${i}`;
const TENANT = "t1";
const MERCHANT = "m1";
const CHAIN = "TRON";
const ASSET = "USDT";

let onChain: Record<string, bigint>;
const balances: AddressBalance = {
  async balance(_c, address) {
    return onChain[address] ?? 0n;
  },
};

let sql: SqlClient;
let ledger: LedgerService;
let pool: PoolManager;
let planner: FeeSweepPlanner;

async function deposit(index: number, gross: bigint, feeBps: number): Promise<void> {
  await ledger.post(
    depositFinalized({
      id: JournalEntryId(`dep-${index}`),
      idempotencyKey: IdempotencyKey(`dep-${index}`),
      asset: Asset(ASSET),
      amount: gross,
      feeBasisPoints: feeBps,
      poolAddr: LedgerAccountKey(`pool_addr:${CHAIN}:${MERCHANT}`),
      merchantAvailable: LedgerAccountKey(`merchant_available:${TENANT}:${MERCHANT}`),
      feeRevenue: LedgerAccountKey(`egofi_fee_revenue:${TENANT}`),
    }),
  );
  onChain[ADDR(index)] = (onChain[ADDR(index)] ?? 0n) + gross;
}

beforeEach(async () => {
  const db = await freshDatabase();
  await db.exec(LEDGER_SCHEMA_SQL);
  await db.exec(POOL_SCHEMA_SQL);
  sql = db.sql;
  ledger = new LedgerService(new SqlLedgerStore(sql));
  onChain = {};
  let index = 0;
  pool = new PoolManager(new SqlPoolStore(sql), () => ADDR(index++), { cooldownMs: 60_000 });
  await pool.assign(TENANT, MERCHANT, CHAIN, "inv-0", "xpub");
  await pool.assign(TENANT, MERCHANT, CHAIN, "inv-1", "xpub");
  planner = new FeeSweepPlanner(sql, pool, balances);
});

describe("what the platform is owed", () => {
  it("is the pool balance minus what the merchant is owed", async () => {
    await deposit(0, 10_000_000n, 50);
    expect(await planner.claim(TENANT, MERCHANT, ASSET)).toBe(50_000n);
  });

  it("accumulates across deposits", async () => {
    await deposit(0, 10_000_000n, 50);
    await deposit(1, 20_000_000n, 50);
    expect(await planner.claim(TENANT, MERCHANT, ASSET)).toBe(150_000n);
  });

  it("is zero for a merchant who is owed everything in their pool", async () => {
    await deposit(0, 10_000_000n, 0);
    expect(await planner.claim(TENANT, MERCHANT, ASSET)).toBe(0n);
  });

  it("never goes negative when liabilities exceed the pool", async () => {
    await ledger.post(
      depositFinalized({
        id: JournalEntryId("dep-x"),
        idempotencyKey: IdempotencyKey("dep-x"),
        asset: Asset(ASSET),
        amount: 1_000_000n,
        feeBasisPoints: 0,
        poolAddr: LedgerAccountKey(`pool_addr:OTHERCHAIN:${MERCHANT}`),
        merchantAvailable: LedgerAccountKey(`merchant_available:${TENANT}:${MERCHANT}`),
        feeRevenue: LedgerAccountKey(`egofi_fee_revenue:${TENANT}`),
      }),
    );

    const plan = await planner.plan(TENANT, MERCHANT, CHAIN, ASSET);
    expect(plan.claimBaseUnits).toBe(0n);
    expect(plan.legs).toEqual([]);
  });
});

describe("planning which addresses pay it", () => {
  it("takes the claim from a funded address", async () => {
    await deposit(0, 10_000_000n, 50);
    const plan = await planner.plan(TENANT, MERCHANT, CHAIN, ASSET);
    expect(plan.legs).toEqual([
      expect.objectContaining({ address: ADDR(0), amountBaseUnits: 50_000n }),
    ]);
  });

  it("will not spend a balance a payout has already committed", async () => {
    await deposit(0, 10_000_000n, 50);
    const reserved = new Map([[ADDR(0), 9_990_000n]]);
    const plan = await planner.plan(TENANT, MERCHANT, CHAIN, ASSET, reserved);
    expect(plan.legs).toEqual([
      expect.objectContaining({ address: ADDR(0), amountBaseUnits: 10_000n }),
    ]);
  });

  it("leaves a residual too small to be worth its gas", async () => {
    await deposit(0, 10_000_000n, 50);
    const dusty = new FeeSweepPlanner(sql, pool, balances, {
      dustThresholdBaseUnits: 100_000n,
    });
    const plan = await dusty.plan(TENANT, MERCHANT, CHAIN, ASSET);
    expect(plan.legs).toEqual([]);
    expect(plan.skippedDust).toBe(1);
    expect(plan.claimBaseUnits).toBe(50_000n);
  });
});

describe("a collected fee leaves the ledger and the chain in agreement", () => {
  const enumerator = {
    async poolGroups() {
      return [{ tenant: TENANT, merchant: MERCHANT, chain: CHAIN, addresses: [ADDR(0), ADDR(1)] }];
    },
  };

  it("reconciles clean after the fee actually moves", async () => {
    await deposit(0, 10_000_000n, 50);

    const plan = await planner.plan(TENANT, MERCHANT, CHAIN, ASSET);
    const leg = plan.legs[0];
    if (!leg) throw new Error("expected a fee leg");

    onChain[leg.address] = (onChain[leg.address] ?? 0n) - leg.amountBaseUnits;

    const { feeSwept } = await import("@/ledger");
    await ledger.post(
      feeSwept({
        id: JournalEntryId("sweep-0"),
        idempotencyKey: IdempotencyKey("sweep-0"),
        asset: Asset(ASSET),
        amount: leg.amountBaseUnits,
        poolAddr: LedgerAccountKey(`pool_addr:${CHAIN}:${MERCHANT}`),
        treasury: LedgerAccountKey(`treasury:${CHAIN}`),
      }),
    );

    let tripped = false;
    const result = await new ExternalReconciler(ledger, enumerator, balances, [ASSET], {
      async trip() {
        tripped = true;
      },
    }).run();

    expect(result.drift).toEqual([]);
    expect(tripped).toBe(false);
  });

  it("trips the breaker if the ledger moves without the coins — the old behaviour", async () => {
    await deposit(0, 10_000_000n, 50);

    const { feeSwept } = await import("@/ledger");
    await ledger.post(
      feeSwept({
        id: JournalEntryId("sweep-book"),
        idempotencyKey: IdempotencyKey("sweep-book"),
        asset: Asset(ASSET),
        amount: 50_000n,
        poolAddr: LedgerAccountKey(`pool_addr:${CHAIN}:${MERCHANT}`),
        treasury: LedgerAccountKey(`treasury:${CHAIN}`),
      }),
    );

    let tripped = false;
    const result = await new ExternalReconciler(ledger, enumerator, balances, [ASSET], {
      async trip() {
        tripped = true;
      },
    }).run();

    expect(result.drift).toHaveLength(1);
    expect(tripped).toBe(true);
  });
});
