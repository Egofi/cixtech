import { MemoryLedgerStore } from "@/ledger/adapters/memory-store.js";
import { LedgerService } from "@/ledger/ledger.service.js";
import { depositFinalized, reverse } from "@/ledger/posting-flows.js";
import { Asset, IdempotencyKey, JournalEntryId, LedgerAccountKey } from "@/types";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { balancedEntry } from "./arbitraries.js";

const POOL = LedgerAccountKey("pool_addr:TRON:m1");
const AVAILABLE = LedgerAccountKey("merchant_available:t1:m1");
const FEE = LedgerAccountKey("egofi_fee_revenue:t1");
const USDT = Asset("USDT");

describe("idempotency & reorg", () => {
  // Property 4 — replaying an idempotency key is a no-op; no double-credit.
  it("[4] re-posting the same idempotencyKey changes nothing", async () => {
    await fc.assert(
      fc.asyncProperty(balancedEntry(), async (entry) => {
        const store = new MemoryLedgerStore();
        const first = await store.append(entry);
        const before = await store.balance(LedgerAccountKey("pool_addr:TRON:m1"), Asset("USDT"));
        const second = await store.append(entry);
        const after = await store.balance(LedgerAccountKey("pool_addr:TRON:m1"), Asset("USDT"));

        expect(first.applied).toBe(true);
        expect(second.applied).toBe(false);
        expect(after).toBe(before);
      }),
    );
  });

  // Property 5 — apply(deposit) then reverse(deposit) restores every balance exactly.
  // This is entry-level reorg safety: a finalized deposit reorged out leaves no trace.
  it("[5] a deposit followed by its reversal nets to the pre-deposit state", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.bigInt({ min: 1n, max: 10n ** 30n }),
        fc.integer({ min: 0, max: 9_999 }),
        async (amount, feeBasisPoints) => {
          const store = new MemoryLedgerStore();
          const svc = new LedgerService(store);
          const accounts = [POOL, AVAILABLE, FEE] as const;
          const before = await Promise.all(accounts.map((a) => store.balance(a, USDT)));

          const deposit = depositFinalized({
            id: JournalEntryId("dep"),
            idempotencyKey: IdempotencyKey("dep"),
            asset: USDT,
            amount,
            feeBasisPoints,
            poolAddr: POOL,
            merchantAvailable: AVAILABLE,
            feeRevenue: FEE,
          });
          await svc.post(deposit);
          // The deposit genuinely moved value before we undo it (not a no-op).
          expect(await store.balance(POOL, USDT)).toBe(amount);

          // A reversal must carry a DISTINCT idempotency key, or the store dedupes it.
          await svc.post(reverse(deposit, JournalEntryId("rev"), IdempotencyKey("rev")));

          const after = await Promise.all(accounts.map((a) => store.balance(a, USDT)));
          expect(after).toEqual(before); // every touched balance back to exactly where it started
        },
      ),
    );
  });

  // Property 6 (detect / finalize / reverse keep solvency) lives in solvency.property.test.ts,
  // since it asserts the solvency invariant rather than balance restoration.
});
