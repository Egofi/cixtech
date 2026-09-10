import type {
  Asset,
  JournalEntry,
  JournalEntryId,
  LedgerAccountKey,
  Posting,
  TotalsByType,
} from "@/types";

export interface LedgerStore {
  append(entry: JournalEntry): Promise<{ applied: boolean }>;

  balance(account: LedgerAccountKey, asset: Asset): Promise<bigint>;

  postingsFor(account: LedgerAccountKey, asset: Asset): Promise<readonly Posting[]>;

  entryPostings(entryId: JournalEntryId): Promise<readonly Posting[]>;

  totalsByType(): Promise<TotalsByType>;
}
