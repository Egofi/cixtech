import { ExternalReconciler, type IndependentBalanceSource } from "@/chains";
import { depositFinalized } from "@/ledger";
import { LedgerService } from "@/services";
import { MemoryLedgerStore } from "@/stores";
import { Asset, IdempotencyKey, JournalEntryId, LedgerAccountKey, type PoolGroup } from "@/types";
import { planExternalReconciliation } from "@/worker/reconcile-wiring.js";
import { describe, expect, it } from "vitest";

describe("external reconciliation only runs against a real chain source", () => {
  it("is enabled when asked for and a chain router exists", () => {
    expect(
      planExternalReconciliation({ chainBalancesEnabled: true, hasChainRouter: true }),
    ).toMatchObject({ enabled: true });
  });

  it("is off — not stubbed — when the operator has not enabled it", () => {
    const plan = planExternalReconciliation({ chainBalancesEnabled: false, hasChainRouter: true });
    expect(plan.enabled).toBe(false);
    expect(plan.reason).toMatch(/CIXTECH_RECONCILE_CHAIN_BALANCES/);
  });

  it("is off when there is no chain router, even if it was asked for", () => {
    const plan = planExternalReconciliation({ chainBalancesEnabled: true, hasChainRouter: false });
    expect(plan.enabled).toBe(false);
    expect(plan.reason).toMatch(/chain router/);
  });
});

describe("regression: why a placeholder balance source must never be wired", () => {
  /**
   * The worker used to fall back to a source that returned 0n for every address
   * while still passing the global kill switch as the breaker. Every credited
   * deposit then read as drift, so the first deposit froze every payout on every
   * chain one reconcile interval later, and re-froze it after each manual reset.
   *
   * The reconciler is right to trip on real drift — that is ADR 0010. This pins
   * the reason the *source* is the thing that must never be faked.
   */
  const zeroSource: IndependentBalanceSource = {
    async balance() {
      return 0n;
    },
  };

  const group: PoolGroup = {
    tenant: "t1",
    merchant: "m1",
    chain: "TRON",
    addresses: ["A"],
  };

  async function ledgerWithDeposit(): Promise<LedgerService> {
    const ledger = new LedgerService(new MemoryLedgerStore());
    await ledger.post(
      depositFinalized({
        id: JournalEntryId("dep"),
        idempotencyKey: IdempotencyKey("dep"),
        asset: Asset("USDT"),
        amount: 1_000n,
        feeBasisPoints: 0,
        poolAddr: LedgerAccountKey("pool_addr:TRON:m1"),
        merchantAvailable: LedgerAccountKey("merchant_available:t1:m1"),
        feeRevenue: LedgerAccountKey("egofi_fee_revenue:t1"),
      }),
    );
    return ledger;
  }

  it("a zero-returning source reports one credited deposit as drift and trips", async () => {
    const reasons: string[] = [];
    const reconciler = new ExternalReconciler(
      await ledgerWithDeposit(),
      {
        async poolGroups() {
          return [group];
        },
      },
      zeroSource,
      ["USDT"],
      {
        async trip(reason) {
          reasons.push(reason);
        },
      },
    );

    const result = await reconciler.run();

    expect(result.tripped).toBe(true);
    expect(result.drift).toHaveLength(1);
    expect(result.drift[0]).toMatchObject({ ledger: 1_000n, onChain: 0n });
    expect(reasons[0]).toMatch(/drift/i);
  });

  it("the same ledger against a truthful source reports no drift", async () => {
    const reasons: string[] = [];
    const reconciler = new ExternalReconciler(
      await ledgerWithDeposit(),
      {
        async poolGroups() {
          return [group];
        },
      },
      {
        async balance() {
          return 1_000n;
        },
      },
      ["USDT"],
      {
        async trip(reason) {
          reasons.push(reason);
        },
      },
    );

    const result = await reconciler.run();

    expect(result.drift).toEqual([]);
    expect(result.tripped).toBe(false);
    expect(reasons).toEqual([]);
  });
});
