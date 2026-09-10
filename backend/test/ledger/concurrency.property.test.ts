import {
  Asset,
  IdempotencyKey,
  type JournalEntry,
  JournalEntryId,
  LedgerAccountKey,
} from "@/types";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Harness, close, freshStore, reset } from "./postgres.js";

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

  it("[10] concurrent appends never lose an update", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.bigInt({ min: 1n, max: 10n ** 18n }), { minLength: 1, maxLength: 40 }),
        async (amounts) => {
          await reset(h);
          const { store } = h;
          await Promise.all(amounts.map((amt, i) => store.append(entry(`e${i}`, amt))));

          const total = amounts.reduce((s, a) => s + a, 0n);
          expect(await store.balance(A, USDT)).toBe(total);
          expect(await store.balance(B, USDT)).toBe(-total);
        },
      ),
      { numRuns: 15 },
    );
  });

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

          expect(results.filter((r) => r.applied)).toHaveLength(1);
          expect(await store.balance(A, USDT)).toBe(amount);
          expect(await store.postingsFor(A, USDT)).toHaveLength(1);
        },
      ),
      { numRuns: 15 },
    );
  });
});
