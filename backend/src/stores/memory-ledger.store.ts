import { accountTypeOf } from "@/ledger/account-classify.js";

import type { LedgerStore } from "@/ledger/ledger.port.js";

import {
  AccountType,
  type Asset,
  type JournalEntry,
  type JournalEntryId,
  type LedgerAccountKey,
  type Posting,
  type TotalsByType,
} from "@/types";

const signed = (p: Posting): bigint => (p.direction === "DEBIT" ? p.amount : -p.amount);

export class MemoryLedgerStore implements LedgerStore {
  private readonly seenKeys = new Set<string>();
  private readonly postings: Posting[] = [];
  private readonly byEntry = new Map<string, Posting[]>();

  async append(entry: JournalEntry): Promise<{ applied: boolean }> {
    if (this.seenKeys.has(entry.idempotencyKey)) return { applied: false };
    this.seenKeys.add(entry.idempotencyKey);
    this.postings.push(...entry.postings);
    this.byEntry.set(String(entry.id), [...entry.postings]);
    return { applied: true };
  }

  async entryPostings(entryId: JournalEntryId): Promise<readonly Posting[]> {
    return this.byEntry.get(String(entryId)) ?? [];
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

      const normalPositive =
        type === AccountType.Asset || type === AccountType.Expense ? signed(p) : -signed(p);
      const perAsset = totals.get(type) ?? new Map<string, bigint>();
      perAsset.set(p.asset, (perAsset.get(p.asset) ?? 0n) + normalPositive);
      totals.set(type, perAsset);
    }
    return totals;
  }
}
