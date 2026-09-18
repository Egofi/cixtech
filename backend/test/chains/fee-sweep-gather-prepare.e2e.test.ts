import {
  type AddressBalance,
  EoaFundTransferStrategy,
  GatherStrategyRegistry,
  PoolManager,
} from "@/attribution";
import { FeeSweepPlanner } from "@/chains/treasury/fee-sweep-planner.js";
import { depositFinalized } from "@/ledger";
import { LEDGER_SCHEMA_SQL, POOL_SCHEMA_SQL } from "@/schemas/sql";
import { FeeSweepService, LedgerService } from "@/services";
import { SqlLedgerStore, SqlPoolStore } from "@/stores";
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
import { beforeEach, describe, expect, it } from "vitest";

const TENANT = "t1";
const MERCHANT = "m1";
const CHAIN = "POLYGON";
const ASSET = "USDC";
const NATIVE = "POL";
const TREASURY = "0xtreasury";
const GAS_PER_TRANSFER = 21_000n;
const ADDR = (i: number) => `0xpool${i}`;

let sql: SqlClient;
let ledger: LedgerService;
let pool: PoolManager;
let planner: FeeSweepPlanner;
let onChain: Record<string, bigint>;

const balances: AddressBalance = {
  async balance(_chain, address) {
    return onChain[address] ?? 0n;
  },
};

class RecordingBroadcaster {
  calls: Array<{ from: string; to: string; amount: bigint }> = [];
  async send(req: PayoutRequest): Promise<BroadcastResult> {
    this.calls.push({
      from: req.fromAddress,
      to: req.toAddress,
      amount: req.amountBaseUnits,
    });
    return { txId: `tx-${this.calls.length}` };
  }
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

  // A deposit that accrues fee revenue the sweep can claim.
  await ledger.post(
    depositFinalized({
      id: JournalEntryId("dep-0"),
      idempotencyKey: IdempotencyKey("dep-0"),
      asset: Asset(ASSET),
      amount: 1_000_000n,
      feeBasisPoints: 50,
      poolAddr: LedgerAccountKey(`pool_addr:${CHAIN}:${MERCHANT}`),
      merchantAvailable: LedgerAccountKey(`merchant_available:${TENANT}:${MERCHANT}`),
      feeRevenue: LedgerAccountKey(`egofi_fee_revenue:${TENANT}`),
    }),
  );
  onChain[ADDR(0)] = 1_000_000n;

  planner = new FeeSweepPlanner(sql, pool, balances);
});

describe("the fee sweep provisions gas before broadcasting a token transfer", () => {
  function strategiesWith(provisioned: Array<{ address: string; min: bigint }>) {
    return new GatherStrategyRegistry([
      new EoaFundTransferStrategy(
        (_c, _x, i) => ADDR(i),
        {
          async provision(input) {
            provisioned.push({ address: input.address, min: input.minNativeBaseUnits });
            return { funded: input.minNativeBaseUnits };
          },
        },
        {
          gasRequirementBaseUnits: new Map([[CHAIN, GAS_PER_TRANSFER]]),
          nativeAssetOf: () => NATIVE,
        },
      ),
    ]);
  }

  it("prepares each leg's address when a strategy registry is supplied", async () => {
    const provisioned: Array<{ address: string; min: bigint }> = [];
    const broadcaster = new RecordingBroadcaster();

    const service = new FeeSweepService(sql, ledger, planner, broadcaster, {
      treasuryAddressFor: () => TREASURY,
      gatherStrategies: strategiesWith(provisioned),
    });

    const result = await service.sweep(ASSET);

    expect(result.sweptCount).toBe(1);
    expect(broadcaster.calls).toEqual([{ from: ADDR(0), to: TREASURY, amount: 5_000n }]);
    // Gas first, for the exact address the transfer is sent from.
    expect(provisioned).toEqual([{ address: ADDR(0), min: GAS_PER_TRANSFER }]);
  });

  it("regression: without a registry the transfer is broadcast with no gas provisioned", async () => {
    // This is what the admin console did, because `Engine` did not expose
    // `gatherStrategies` for `AdminService.sweepFees` to pass through. The sweep
    // still "succeeds" against a fake broadcaster — on a real EVM chain the
    // transfer would fail for want of gas, which is why this needed a test
    // rather than a passing suite.
    const provisioned: Array<{ address: string; min: bigint }> = [];
    const broadcaster = new RecordingBroadcaster();

    const service = new FeeSweepService(sql, ledger, planner, broadcaster, {
      treasuryAddressFor: () => TREASURY,
    });

    await service.sweep(ASSET);

    expect(broadcaster.calls).toHaveLength(1);
    expect(provisioned).toEqual([]);
  });
});
