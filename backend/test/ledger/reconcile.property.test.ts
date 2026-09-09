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

describe("persistence: internal reconciler (Postgres)", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await freshStore();
  });

  afterAll(async () => {
    await close(h);
  });

  it("[12] reconciler is clean when consistent and catches an out-of-band mutation", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.bigInt({ min: 1n, max: 10n ** 18n }), { minLength: 1, maxLength: 20 }),
        async (amounts) => {
          await reset(h);
          const { sql, store } = h;
          for (let i = 0; i < amounts.length; i++) {
            await store.append(entry(`e${i}`, amounts[i] as bigint));
          }

          expect(await store.reconcileInternal()).toEqual([]);

          await sql.query("UPDATE posting SET amount = amount + 1 WHERE account = $1", [A]);

          const drift = await store.reconcileInternal();
          expect(drift.length).toBeGreaterThan(0);
          expect(drift.some((d) => d.account === A && d.asset === USDT)).toBe(true);

          for (const d of drift) expect(d.materialized).not.toBe(d.fromHistory);
        },
      ),
      { numRuns: 15 },
    );
  });
});
