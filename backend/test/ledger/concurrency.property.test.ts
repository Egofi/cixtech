import type { JournalEntry } from "@/ledger/entry.js";
import { Asset, IdempotencyKey, JournalEntryId, LedgerAccountKey } from "@/types";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Harness, close, freshStore, reset } from "./postgres.js";

// Real PostgreSQL, real parallelism: `append` claims one pooled connection per
// transaction, so these writers genuinely race inside the server the way they
// will in production. That is the whole point of the suite — a single-connection
// database serializes the submissions and the properties pass without proving
// anything. Property 11 in particular only fails under true concurrency.

const A = LedgerAccountKey("pool_addr:TRON:m1");
const B = LedgerAccountKey("merchant_available:t1:m1");
const USDT = Asset("USDT");

function entry(tag: string, amount: bigint): JournalEntry {
  return {
    id: JournalEntryId(tag),
    idempotencyKey: IdempotencyKey(tag),
    kind: "test.transfer",
    postings: [
      { account: A, asset: USDT, amount, direction: "DEBIT" },
      { account: B, asset: USDT, amount, direction: "CREDIT" },
    ],
    occurredAt: new Date(),
  };
}

describe("persistence: concurrency (Postgres)", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await freshStore();
  });

  afterAll(async () => {
    await close(h);
  });

  // Property 10 — concurrently-submitted appends accumulate exactly; none lost.
  it("[10] concurrent appends never lose an update", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.bigInt({ min: 1n, max: 10n ** 18n }), { minLength: 1, maxLength: 40 }),
        async (amounts) => {
          await reset(h);
          const { store } = h;
          await Promise.all(amounts.map((amt, i) => store.append(entry(`e${i}`, amt))));

          const total = amounts.reduce((s, a) => s + a, 0n);
          expect(await store.balance(A, USDT)).toBe(total); // debit-normal: +total
          expect(await store.balance(B, USDT)).toBe(-total); // credit-normal: -total
        },
      ),
      { numRuns: 15 },
    );
  });

  // Property 11 — a duplicate idempotency key applies exactly once, however many attempts race.
  it("[11] racing duplicate idempotencyKey applies exactly once", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.bigInt({ min: 1n, max: 10n ** 18n }),
        fc.integer({ min: 2, max: 8 }),
        async (amount, attempts) => {
          await reset(h);
          const { store } = h;
          const e = entry("dup", amount);
          const results = await Promise.all(
            Array.from({ length: attempts }, () => store.append(e)),
          );

          expect(results.filter((r) => r.applied)).toHaveLength(1); // exactly one winner
          expect(await store.balance(A, USDT)).toBe(amount); // applied once, not `attempts` times
          expect(await store.postingsFor(A, USDT)).toHaveLength(1);
        },
      ),
      { numRuns: 15 },
    );
  });
});
