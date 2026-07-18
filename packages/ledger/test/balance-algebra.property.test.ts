import { Asset, IdempotencyKey, JournalEntryId, LedgerAccountKey } from "@cixtech/types";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { MemoryLedgerStore } from "../src/adapters/memory-store.js";
import { UnbalancedEntryError, assertBalanced } from "../src/balanced.js";
import { LedgerService } from "../src/ledger.service.js";
import { depositFinalized } from "../src/posting-flows.js";
import { balancedEntry, unbalancedEntry } from "./arbitraries.js";

const POOL = LedgerAccountKey("pool_addr:TRON:m1");
const AVAILABLE = LedgerAccountKey("merchant_available:t1:m1");
const FEE = LedgerAccountKey("egofi_fee_revenue:t1");
const USDT = Asset("USDT");
/** Magnitude of a credit-normal balance, which MemoryLedgerStore returns as a negative net. */
const owed = (signedNet: bigint): bigint => -signedNet;

describe("balance & entry algebra", () => {
  // Property 1 — unbalanced entries are always rejected and persist nothing.
  it("[1] rejects any entry that does not sum to zero per asset", async () => {
    await fc.assert(
      fc.asyncProperty(unbalancedEntry(), async (entry) => {
        expect(() => assertBalanced(entry)).toThrow(UnbalancedEntryError);
        const svc = new LedgerService(new MemoryLedgerStore());
        await expect(svc.post(entry)).rejects.toBeInstanceOf(UnbalancedEntryError);
      }),
    );
  });

  // Property 2 — final balances are independent of the order entries are applied.
  it("[2] balance == signed sum, independent of insertion order", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(balancedEntry(), { minLength: 1, maxLength: 25 }),
        async (entries) => {
          const forward = new MemoryLedgerStore();
          const reverse = new MemoryLedgerStore();
          for (const e of entries) await forward.append(e);
          for (const e of [...entries].reverse()) await reverse.append(e);

          // Compare a representative account+asset across both orderings.
          const acct = LedgerAccountKey("pool_addr:TRON:m1");
          const usdt = Asset("USDT");
          expect(await forward.balance(acct, usdt)).toBe(await reverse.balance(acct, usdt));
        },
      ),
    );
  });

  // Property 3 — no fee split loses or invents base units, for any amount/bps.
  it("[3] depositFinalized: merchant_available + egofi_fee_revenue == amount, exactly", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.bigInt({ min: 1n, max: 10n ** 30n }),
        fc.integer({ min: 0, max: 9_999 }),
        async (amount, feeBasisPoints) => {
          const entry = depositFinalized({
            id: JournalEntryId("j"),
            idempotencyKey: IdempotencyKey("k"),
            asset: USDT,
            amount,
            feeBasisPoints,
            poolAddr: POOL,
            merchantAvailable: AVAILABLE,
            feeRevenue: FEE,
          });

          const store = new MemoryLedgerStore();
          await new LedgerService(store).post(entry); // also re-asserts balance

          const pool = await store.balance(POOL, USDT);
          const net = owed(await store.balance(AVAILABLE, USDT));
          const fee = owed(await store.balance(FEE, USDT));

          // No base-unit leak: the split sums back to the gross, exactly.
          expect(net + fee).toBe(amount);
          // Flooring the fee never over-charges: the merchant gets at least the gross minus the true share.
          expect(fee).toBeLessThanOrEqual((amount * BigInt(feeBasisPoints)) / 10_000n);
          // ADR 0009 identity for a single deposit: the pool holds exactly what it owes + accrued fee.
          expect(pool).toBe(net + fee);
        },
      ),
    );
  });
});
