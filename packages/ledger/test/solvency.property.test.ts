import { Asset, IdempotencyKey, JournalEntryId, LedgerAccountKey } from "@cixtech/types";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { MemoryLedgerStore } from "../src/adapters/memory-store.js";
import { InsufficientFundsError, LedgerService } from "../src/ledger.service.js";
import { depositFinalized, splitFee } from "../src/posting-flows.js";

const POOL = LedgerAccountKey("pool_addr:TRON:m1");
const AVAILABLE = LedgerAccountKey("merchant_available:t1:m1");
const PENDING = LedgerAccountKey("merchant_pending_withdrawal:t1:m1");
const FEE = LedgerAccountKey("egofi_fee_revenue:t1");
const USDT = Asset("USDT");

/** Fund a merchant by finalizing one deposit; returns their resulting available balance. */
async function fundMerchant(svc: LedgerService, amount: bigint, bps: number): Promise<bigint> {
  await svc.post(
    depositFinalized({
      id: JournalEntryId("dep"),
      idempotencyKey: IdempotencyKey("dep"),
      asset: USDT,
      amount,
      feeBasisPoints: bps,
      poolAddr: POOL,
      merchantAvailable: AVAILABLE,
      feeRevenue: FEE,
    }),
  );
  return svc.availableBalance(AVAILABLE, USDT);
}

describe("solvency invariant", () => {
  // Property 7 — Σ ASSET ≥ Σ LIABILITY holds at every step of any valid history.
  it.todo("[7] solvency holds across any generated deposit/finalize/payout/fee/reversal history");

  // Property 8 — a payout over the available balance is rejected; available never goes negative.
  it("[8] over-withdrawal is rejected; no negative available balance is reachable", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.bigInt({ min: 1n, max: 10n ** 30n }),
        fc.integer({ min: 0, max: 9_999 }),
        fc.bigInt({ min: 1n, max: 10n ** 30n }),
        async (amount, bps, payout) => {
          const svc = new LedgerService(new MemoryLedgerStore());
          const available = await fundMerchant(svc, amount, bps);
          expect(available).toBe(splitFee(amount, bps).net); // sanity: available == net of the deposit

          const lock = svc.lockPayout({
            id: JournalEntryId("pay"),
            idempotencyKey: IdempotencyKey("pay"),
            asset: USDT,
            amount: payout,
            merchantAvailable: AVAILABLE,
            merchantPendingWithdrawal: PENDING,
          });

          if (payout > available) {
            await expect(lock).rejects.toBeInstanceOf(InsufficientFundsError);
            // Rejected payout changes nothing.
            expect(await svc.availableBalance(AVAILABLE, USDT)).toBe(available);
            expect(await svc.availableBalance(PENDING, USDT)).toBe(0n);
          } else {
            await lock;
            expect(await svc.availableBalance(AVAILABLE, USDT)).toBe(available - payout);
            expect(await svc.availableBalance(PENDING, USDT)).toBe(payout);
          }
          // The invariant either branch must uphold: available is never negative.
          expect(await svc.availableBalance(AVAILABLE, USDT)).toBeGreaterThanOrEqual(0n);
        },
      ),
    );
  });

  // Property 9 — ADR 0009 identity: pool_addr == merchant_available + accrued unswept fee.
  it.todo("[9] pool_addr balance == merchant_available + accrued-unswept egofi_fee_revenue");
});
