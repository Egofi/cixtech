import { UnbalancedEntryError } from "@/common";
import { LedgerService } from "@/services";
import { MemoryLedgerStore } from "@/stores";

import { assertBalanced } from "@/ledger/balanced.js";

import { depositFinalized } from "@/ledger/posting-flows.js";
import { Asset, IdempotencyKey, JournalEntryId, LedgerAccountKey } from "@/types";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { balancedEntry, unbalancedEntry } from "./arbitraries.js";

const POOL = LedgerAccountKey("pool_addr:TRON:m1");
const AVAILABLE = LedgerAccountKey("merchant_available:t1:m1");
const FEE = LedgerAccountKey("egofi_fee_revenue:t1");
const USDT = Asset("USDT");

const owed = (signedNet: bigint): bigint => -signedNet;

describe("balance & entry algebra", () => {
  it("[1] rejects any entry that does not sum to zero per asset", async () => {
    await fc.assert(
      fc.asyncProperty(unbalancedEntry(), async (entry) => {
        expect(() => assertBalanced(entry)).toThrow(UnbalancedEntryError);
        const svc = new LedgerService(new MemoryLedgerStore());
        await expect(svc.post(entry)).rejects.toBeInstanceOf(UnbalancedEntryError);
      }),
    );
  });

  it("[2] balance == signed sum, independent of insertion order", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(balancedEntry(), { minLength: 1, maxLength: 25 }),
        async (entries) => {
          const forward = new MemoryLedgerStore();
          const reverse = new MemoryLedgerStore();
          for (const e of entries) await forward.append(e);
          for (const e of [...entries].reverse()) await reverse.append(e);

          const acct = LedgerAccountKey("pool_addr:TRON:m1");
          const usdt = Asset("USDT");
          expect(await forward.balance(acct, usdt)).toBe(await reverse.balance(acct, usdt));
        },
      ),
    );
  });

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
          await new LedgerService(store).post(entry);

          const pool = await store.balance(POOL, USDT);
          const net = owed(await store.balance(AVAILABLE, USDT));
          const fee = owed(await store.balance(FEE, USDT));

          expect(net + fee).toBe(amount);

          expect(fee).toBeLessThanOrEqual((amount * BigInt(feeBasisPoints)) / 10_000n);

          expect(pool).toBe(net + fee);
        },
      ),
    );
  });
});
