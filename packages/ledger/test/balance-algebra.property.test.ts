import { Asset, LedgerAccountKey } from "@cixtech/types";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { MemoryLedgerStore } from "../src/adapters/memory-store.js";
import { UnbalancedEntryError, assertBalanced } from "../src/balanced.js";
import { LedgerService } from "../src/ledger.service.js";
import { balancedEntry, unbalancedEntry } from "./arbitraries.js";

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

  // Property 3 — no fee split or conversion loses or invents base units.
  it.todo("[3] depositFinalized: merchant_available + egofi_fee_revenue == amount, exactly");
});
