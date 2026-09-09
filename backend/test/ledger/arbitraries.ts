import {
  Asset,
  IdempotencyKey,
  type JournalEntry,
  JournalEntryId,
  LedgerAccountKey,
  type Posting,
} from "@/types";
import fc from "fast-check";

const ACCOUNTS = [
  "pool_addr:TRON:m1",
  "treasury:TRON",
  "merchant_available:t1:m1",
  "egofi_fee_revenue:t1",
  "network_fee_expense",
] as const;

const ASSETS = ["USDT", "TRX"] as const;

export const account = () => fc.constantFrom(...ACCOUNTS).map((s) => LedgerAccountKey(s));
export const asset = () => fc.constantFrom(...ASSETS).map((s) => Asset(s));
export const amount = () => fc.bigInt({ min: 1n, max: 10n ** 18n });

export const balancedEntry = (): fc.Arbitrary<JournalEntry> =>
  fc
    .tuple(
      fc.uuid(),
      fc.uuid(),
      asset(),
      amount(),
      fc.constantFrom(...ACCOUNTS),
      fc.constantFrom(...ACCOUNTS),
    )
    .filter(([, , , , a, b]) => a !== b)
    .map(([id, key, as, amt, a, b]): JournalEntry => {
      const postings: Posting[] = [
        { account: LedgerAccountKey(a), asset: as, amount: amt, direction: "DEBIT" },
        { account: LedgerAccountKey(b), asset: as, amount: amt, direction: "CREDIT" },
      ];
      return {
        id: JournalEntryId(id),
        idempotencyKey: IdempotencyKey(key),
        kind: "test.balanced",
        postings,
        occurredAt: new Date(),
      };
    });

export const unbalancedEntry = (): fc.Arbitrary<JournalEntry> =>
  balancedEntry().map((e) => {
    const last = e.postings.length - 1;
    const postings = e.postings.map((p, i) => (i === last ? { ...p, amount: p.amount + 1n } : p));
    return { ...e, postings };
  });
