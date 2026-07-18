import { Asset, LedgerAccountKey } from "@cixtech/types";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { MemoryLedgerStore } from "../src/adapters/memory-store.js";
import { balancedEntry } from "./arbitraries.js";

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
  it.todo("[5] a deposit followed by its reversal nets to the pre-deposit state");

  // Property 6 — any interleaving of {detect, finalize, reverse} keeps solvency intact.
  it.todo("[6] interleaved deposit lifecycles preserve the solvency invariant");
});
