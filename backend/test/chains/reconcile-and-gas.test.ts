import {
  ExternalReconciler,
  type IndependentBalanceSource,
  type ReconcilerBreaker,
} from "@/chains/reconcile/external-reconciler.js";
import { GasStation, LedgerGasFloat } from "@/chains/treasury/gas-station.js";
import { depositFinalized } from "@/ledger";
import { LedgerService } from "@/services";
import { MemoryLedgerStore } from "@/stores";
import {
  Asset,
  type GasStationConfig,
  IdempotencyKey,
  JournalEntryId,
  LedgerAccountKey,
  type PoolGroup,
} from "@/types";
import { describe, expect, it } from "vitest";

const USDT = "USDT";

async function seededLedger(gross: bigint): Promise<LedgerService> {
  const ledger = new LedgerService(new MemoryLedgerStore());
  await ledger.post(
    depositFinalized({
      id: JournalEntryId("dep"),
      idempotencyKey: IdempotencyKey("dep"),
      asset: Asset(USDT),
      amount: gross,
      feeBasisPoints: 0,
      poolAddr: LedgerAccountKey("pool_addr:TRON:m1"),
      merchantAvailable: LedgerAccountKey("merchant_available:t1:m1"),
      feeRevenue: LedgerAccountKey("egofi_fee_revenue:t1"),
    }),
  );
  return ledger;
}

const group: PoolGroup = { tenant: "t1", merchant: "m1", chain: "TRON", addresses: ["A", "B"] };

class RecordingBreaker implements ReconcilerBreaker {
  reasons: string[] = [];
  async trip(reason: string) {
    this.reasons.push(reason);
  }
}

describe("ExternalReconciler (§8, independent source)", () => {
  it("reports no drift and does not trip when ledger == independent chain sum", async () => {
    const ledger = await seededLedger(1_000n);
    const independent: IndependentBalanceSource = {
      async balance(_c, addr) {
        return addr === "A" ? 600n : 400n;
      },
    };
    const breaker = new RecordingBreaker();
    const recon = new ExternalReconciler(
      ledger,
      {
        async poolGroups() {
          return [group];
        },
      },
      independent,
      [USDT],
      breaker,
    );
    const res = await recon.run();
    expect(res.drift).toHaveLength(0);
    expect(res.tripped).toBe(false);
    expect(breaker.reasons).toHaveLength(0);
  });

  it("trips the breaker on drift (theft / missed deposit / bug)", async () => {
    const ledger = await seededLedger(1_000n);
    const independent: IndependentBalanceSource = {
      async balance() {
        return 300n;
      },
    };
    const breaker = new RecordingBreaker();
    const recon = new ExternalReconciler(
      ledger,
      {
        async poolGroups() {
          return [group];
        },
      },
      independent,
      [USDT],
      breaker,
    );
    const res = await recon.run();
    expect(res.drift).toEqual([
      { tenant: "t1", merchant: "m1", chain: "TRON", asset: USDT, ledger: 1_000n, onChain: 600n },
    ]);
    expect(res.tripped).toBe(true);
    expect(breaker.reasons[0]).toMatch(/drift/i);
  });
});

describe("GasStation (§6.2, breaker-on-depletion)", () => {
  const configs = new Map<string, GasStationConfig>([
    ["TRON", { nativeAsset: "TRX", floorBaseUnits: 1_000n }],
  ]);

  async function ledgerWithGas(balance: bigint): Promise<LedgerService> {
    const ledger = new LedgerService(new MemoryLedgerStore());
    if (balance > 0n) {
      await ledger.post({
        id: JournalEntryId("gas"),
        idempotencyKey: IdempotencyKey("gas"),
        kind: "gas.topup",
        postings: [
          {
            account: LedgerAccountKey("gas_float:TRON"),
            asset: Asset("TRX"),
            amount: balance,
            direction: "DEBIT",
          },
          {
            account: LedgerAccountKey("treasury:TRON"),
            asset: Asset("TRX"),
            amount: balance,
            direction: "CREDIT",
          },
        ],
        occurredAt: new Date(),
      });
    }
    return ledger;
  }

  it("reports healthy above floor and does not trip", async () => {
    const breaker = new RecordingBreaker();
    const station = new GasStation(
      new LedgerGasFloat(await ledgerWithGas(5_000n)),
      configs,
      undefined,
      breaker,
    );
    const [status] = await station.monitor();
    expect(status).toMatchObject({ chain: "TRON", balance: 5_000n, healthy: true });
    expect(breaker.reasons).toHaveLength(0);
  });

  it("trips the breaker when the float falls below floor", async () => {
    const breaker = new RecordingBreaker();
    const station = new GasStation(
      new LedgerGasFloat(await ledgerWithGas(500n)),
      configs,
      undefined,
      breaker,
    );
    const [status] = await station.monitor();
    expect(status?.healthy).toBe(false);
    expect(breaker.reasons[0]).toMatch(/depleted/);
  });
});
