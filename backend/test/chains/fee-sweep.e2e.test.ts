import { type AddressBalance, POOL_SCHEMA_SQL, PoolManager, SqlPoolStore } from "@/attribution";
import { ExternalReconciler } from "@/chains/reconcile/external-reconciler.js";
import { FeeSweepPlanner } from "@/chains/treasury/fee-sweep-planner.js";
import { LEDGER_SCHEMA_SQL, LedgerService, SqlLedgerStore, depositFinalized } from "@/ledger";
import type { SqlClient } from "@/ledger";
import { Asset, IdempotencyKey, JournalEntryId, LedgerAccountKey } from "@/types";
import { freshDatabase } from "@test/support/index.js";
import { beforeEach, describe, expect, it } from "vitest";

const ADDR = (i: number) => `TPool${i}`;
const TENANT = "t1";
const MERCHANT = "m1";
const CHAIN = "TRON";
const ASSET = "USDT";

/** The chain's view, mutated as transfers "land" so ledger and chain can be compared. */
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

/** A 10.000000 USDT deposit: 9.95 to the merchant, 0.05 to fee revenue, 10 into the pool. */
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
    await deposit(0, 10_000_000n, 50); // 10 USDT, 0.5% → merchant 9.95, fee 0.05
    expect(await planner.claim(TENANT, MERCHANT, ASSET)).toBe(50_000n);
  });

  it("accumulates across deposits", async () => {
    await deposit(0, 10_000_000n, 50);
    await deposit(1, 20_000_000n, 50);
    expect(await planner.claim(TENANT, MERCHANT, ASSET)).toBe(150_000n);
  });

  /**
   * The claim is DERIVED from the liabilities, so it cannot exceed them however
   * the arithmetic is approached. This is what makes it safe to compute without a
   * separate per-merchant fee account to drift out of step.
   */
  it("is zero for a merchant who is owed everything in their pool", async () => {
    await deposit(0, 10_000_000n, 0); // no fee taken
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
    // Liability on this merchant, but nothing in THIS chain's pool.
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

  /**
   * The failure this prevents is a fee leg and a payout leg both planning to
   * spend the same coins — the second transfer would fail on chain and turn a
   * bookkeeping improvement into a stuck payout.
   */
  it("will not spend a balance a payout has already committed", async () => {
    await deposit(0, 10_000_000n, 50);
    const reserved = new Map([[ADDR(0), 9_990_000n]]); // leaves only 10_000 free
    const plan = await planner.plan(TENANT, MERCHANT, CHAIN, ASSET, reserved);
    expect(plan.legs).toEqual([
      expect.objectContaining({ address: ADDR(0), amountBaseUnits: 10_000n }),
    ]);
  });

  it("leaves a residual too small to be worth its gas", async () => {
    await deposit(0, 10_000_000n, 50); // claim 50_000
    const dusty = new FeeSweepPlanner(sql, pool, balances, {
      dustThresholdBaseUnits: 100_000n,
    });
    const plan = await dusty.plan(TENANT, MERCHANT, CHAIN, ASSET);
    expect(plan.legs).toEqual([]);
    expect(plan.skippedDust).toBe(1);
    expect(plan.claimBaseUnits).toBe(50_000n);
  });
});

/**
 * The regression that matters most.
 *
 * The previous fee sweep posted a ledger entry and moved nothing, so `pool_addr`
 * fell while the coins stayed put — the exact mismatch `ExternalReconciler`
 * treats as theft. Running it and then enabling the reconciler would trip the
 * circuit breaker and freeze every withdrawal.
 */
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

    // The transfer lands...
    onChain[leg.address] = (onChain[leg.address] ?? 0n) - leg.amountBaseUnits;
    // ...and only then does the ledger follow.
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

    // Book-only: post the entry, move nothing on chain.
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
