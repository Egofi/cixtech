import { InsufficientFundsError } from "@/common";
import { LedgerService } from "@/services";
import { MemoryLedgerStore } from "@/stores";

import {
  depositDetected,
  depositFinalized,
  feeSwept,
  payoutLocked,
  payoutSettled,
  reverse,
  splitFee,
} from "@/ledger/posting-flows.js";
import { Asset, IdempotencyKey, JournalEntryId, LedgerAccountKey } from "@/types";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

const POOL = LedgerAccountKey("pool_addr:TRON:m1");
const UNCONFIRMED = LedgerAccountKey("pool_addr_unconfirmed:TRON:m1");
const TREASURY = LedgerAccountKey("treasury:TRON");
const AVAILABLE = LedgerAccountKey("merchant_available:t1:m1");
const PENDING = LedgerAccountKey("merchant_pending_withdrawal:t1:m1");
const MERCHANT_PENDING = LedgerAccountKey("merchant_pending:t1:m1");
const FEE = LedgerAccountKey("egofi_fee_revenue:t1");
const USDT = Asset("USDT");

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
  it("[6] detect / finalize / reverse keep Σ ASSET ≥ Σ LIABILITY", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            amount: fc.bigInt({ min: 1n, max: 10n ** 18n }),
            bps: fc.integer({ min: 0, max: 9_999 }),
            confirm: fc.boolean(),
          }),
          { maxLength: 25 },
        ),
        async (deposits) => {
          const svc = new LedgerService(new MemoryLedgerStore());
          let n = 0;
          const next = () => {
            const s = `e${n++}`;
            return { id: JournalEntryId(s), idempotencyKey: IdempotencyKey(s) };
          };
          const solvent = async () => expect(await svc.checkSolvency([USDT])).toEqual([]);
          await solvent();

          for (const d of deposits) {
            const detect = depositDetected({
              ...next(),
              asset: USDT,
              amount: d.amount,
              poolAddrUnconfirmed: UNCONFIRMED,
              merchantPending: MERCHANT_PENDING,
            });
            await svc.post(detect);
            await solvent();

            const r = next();
            await svc.post(reverse(detect, r.id, r.idempotencyKey));
            await solvent();

            if (d.confirm) {
              await svc.post(
                depositFinalized({
                  ...next(),
                  asset: USDT,
                  amount: d.amount,
                  feeBasisPoints: d.bps,
                  poolAddr: POOL,
                  merchantAvailable: AVAILABLE,
                  feeRevenue: FEE,
                }),
              );
              await solvent();
            }
          }
        },
      ),
    );
  });

  it("[7] checkSolvency reports no drift across any deposit/lock/settle/sweep history", async () => {
    const clamp = (x: bigint, max: bigint): bigint => (x > max ? max : x);
    const action = fc.oneof(
      fc.record({
        kind: fc.constant("deposit" as const),
        amount: fc.bigInt({ min: 1n, max: 10n ** 18n }),
        bps: fc.integer({ min: 0, max: 9_999 }),
      }),
      fc.record({
        kind: fc.constant("lock" as const),
        num: fc.bigInt({ min: 1n, max: 10n ** 18n }),
      }),
      fc.record({
        kind: fc.constant("settle" as const),
        num: fc.bigInt({ min: 1n, max: 10n ** 18n }),
      }),
      fc.record({
        kind: fc.constant("sweep" as const),
        num: fc.bigInt({ min: 1n, max: 10n ** 18n }),
      }),
    );

    await fc.assert(
      fc.asyncProperty(fc.array(action, { maxLength: 40 }), async (actions) => {
        const svc = new LedgerService(new MemoryLedgerStore());
        const bal = (a: LedgerAccountKey) => svc.availableBalance(a, USDT);
        let n = 0;
        const next = () => {
          const s = `e${n++}`;
          return { id: JournalEntryId(s), idempotencyKey: IdempotencyKey(s) };
        };

        for (const a of actions) {
          if (a.kind === "deposit") {
            await svc.post(
              depositFinalized({
                ...next(),
                asset: USDT,
                amount: a.amount,
                feeBasisPoints: a.bps,
                poolAddr: POOL,
                merchantAvailable: AVAILABLE,
                feeRevenue: FEE,
              }),
            );
          } else if (a.kind === "lock") {
            const amount = clamp(a.num, await bal(AVAILABLE));
            if (amount > 0n) {
              await svc.post(
                payoutLocked({
                  ...next(),
                  asset: USDT,
                  amount,
                  merchantAvailable: AVAILABLE,
                  merchantPendingWithdrawal: PENDING,
                }),
              );
            }
          } else if (a.kind === "settle") {
            const amount = clamp(a.num, await bal(PENDING));
            if (amount > 0n) {
              await svc.post(
                payoutSettled({
                  ...next(),
                  asset: USDT,
                  amount,
                  merchantPendingWithdrawal: PENDING,
                  poolAddr: POOL,
                }),
              );
            }
          } else {
            const unswept = (await bal(FEE)) - (await bal(TREASURY));
            const amount = clamp(a.num, unswept);
            if (amount > 0n) {
              await svc.post(
                feeSwept({ ...next(), asset: USDT, amount, poolAddr: POOL, treasury: TREASURY }),
              );
            }
          }
          expect(await svc.checkSolvency([USDT])).toEqual([]);
        }
      }),
    );
  });

  it("[8] over-withdrawal is rejected; no negative available balance is reachable", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.bigInt({ min: 1n, max: 10n ** 30n }),
        fc.integer({ min: 0, max: 9_999 }),
        fc.bigInt({ min: 1n, max: 10n ** 30n }),
        async (amount, bps, payout) => {
          const svc = new LedgerService(new MemoryLedgerStore());
          const available = await fundMerchant(svc, amount, bps);
          expect(available).toBe(splitFee(amount, bps).net);

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

            expect(await svc.availableBalance(AVAILABLE, USDT)).toBe(available);
            expect(await svc.availableBalance(PENDING, USDT)).toBe(0n);
          } else {
            await lock;
            expect(await svc.availableBalance(AVAILABLE, USDT)).toBe(available - payout);
            expect(await svc.availableBalance(PENDING, USDT)).toBe(payout);
          }

          expect(await svc.availableBalance(AVAILABLE, USDT)).toBeGreaterThanOrEqual(0n);
        },
      ),
    );
  });

  it("[9] pool + treasury == available + pending + fee_revenue, at every step", async () => {
    const clamp = (x: bigint, max: bigint): bigint => (x > max ? max : x);
    const action = fc.oneof(
      fc.record({
        kind: fc.constant("deposit" as const),
        amount: fc.bigInt({ min: 1n, max: 10n ** 18n }),
        bps: fc.integer({ min: 0, max: 9_999 }),
      }),
      fc.record({
        kind: fc.constant("lock" as const),
        num: fc.bigInt({ min: 1n, max: 10n ** 18n }),
      }),
      fc.record({
        kind: fc.constant("settle" as const),
        num: fc.bigInt({ min: 1n, max: 10n ** 18n }),
      }),
      fc.record({
        kind: fc.constant("sweep" as const),
        num: fc.bigInt({ min: 1n, max: 10n ** 18n }),
      }),
    );

    await fc.assert(
      fc.asyncProperty(fc.array(action, { maxLength: 40 }), async (actions) => {
        const svc = new LedgerService(new MemoryLedgerStore());
        const bal = (a: LedgerAccountKey) => svc.availableBalance(a, USDT);
        let n = 0;
        const next = () => {
          const s = `e${n++}`;
          return { id: JournalEntryId(s), idempotencyKey: IdempotencyKey(s) };
        };

        for (const a of actions) {
          if (a.kind === "deposit") {
            await svc.post(
              depositFinalized({
                ...next(),
                asset: USDT,
                amount: a.amount,
                feeBasisPoints: a.bps,
                poolAddr: POOL,
                merchantAvailable: AVAILABLE,
                feeRevenue: FEE,
              }),
            );
          } else if (a.kind === "lock") {
            const amount = clamp(a.num, await bal(AVAILABLE));
            if (amount > 0n) {
              await svc.post(
                payoutLocked({
                  ...next(),
                  asset: USDT,
                  amount,
                  merchantAvailable: AVAILABLE,
                  merchantPendingWithdrawal: PENDING,
                }),
              );
            }
          } else if (a.kind === "settle") {
            const amount = clamp(a.num, await bal(PENDING));
            if (amount > 0n) {
              await svc.post(
                payoutSettled({
                  ...next(),
                  asset: USDT,
                  amount,
                  merchantPendingWithdrawal: PENDING,
                  poolAddr: POOL,
                }),
              );
            }
          } else {
            const unswept = (await bal(FEE)) - (await bal(TREASURY));
            const amount = clamp(a.num, unswept);
            if (amount > 0n) {
              await svc.post(
                feeSwept({ ...next(), asset: USDT, amount, poolAddr: POOL, treasury: TREASURY }),
              );
            }
          }

          const [pool, treasury, available, pending, fee] = await Promise.all([
            bal(POOL),
            bal(TREASURY),
            bal(AVAILABLE),
            bal(PENDING),
            bal(FEE),
          ]);
          expect(pool + treasury).toBe(available + pending + fee);
        }
      }),
    );
  });
});
