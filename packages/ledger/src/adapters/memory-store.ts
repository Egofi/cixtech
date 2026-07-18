import { AccountType, type Asset, type LedgerAccountKey } from "@cixtech/types";
import { accountTypeOf } from "../account-classify.js";
import type { JournalEntry, Posting } from "../entry.js";
import type { LedgerStore } from "../ledger.port.js";
import type { TotalsByType } from "../solvency.js";

/**
 * In-memory LedgerStore for the fast algebraic property suites. Deliberately
 * naive (linear scans): correctness over speed. The Prisma adapter mirrors this
 * behaviour under real concurrency.
 */
const signed = (p: Posting): bigint => (p.direction === "DEBIT" ? p.amount : -p.amount);

export class MemoryLedgerStore implements LedgerStore {
  private readonly seenKeys = new Set<string>();
  private readonly postings: Posting[] = [];

  async append(entry: JournalEntry): Promise<{ applied: boolean }> {
    if (this.seenKeys.has(entry.idempotencyKey)) return { applied: false };
    this.seenKeys.add(entry.idempotencyKey);
    this.postings.push(...entry.postings);
    return { applied: true };
  }

  async balance(account: LedgerAccountKey, asset: Asset): Promise<bigint> {
    let net = 0n;
    for (const p of this.postings) {
      if (p.account === account && p.asset === asset) net += signed(p);
    }
    return net;
  }

  async postingsFor(account: LedgerAccountKey, asset: Asset): Promise<readonly Posting[]> {
    return this.postings.filter((p) => p.account === account && p.asset === asset);
  }

  async totalsByType(): Promise<TotalsByType> {
    const totals: TotalsByType = new Map();
    for (const p of this.postings) {
      const type = accountTypeOf(p.account);
      // ASSET/EXPENSE are debit-normal; LIABILITY/REVENUE credit-normal. Store the
      // magnitude on each type's normal side so the solvency compare is apples-to-apples.
      const normalPositive =
        type === AccountType.Asset || type === AccountType.Expense ? signed(p) : -signed(p);
      const perAsset = totals.get(type) ?? new Map<string, bigint>();
      perAsset.set(p.asset, (perAsset.get(p.asset) ?? 0n) + normalPositive);
      totals.set(type, perAsset);
    }
    return totals;
  }
}
