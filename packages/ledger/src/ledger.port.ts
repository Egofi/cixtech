import type { Asset, LedgerAccountKey } from "@cixtech/types";
import type { JournalEntry, Posting } from "./entry.js";
import type { TotalsByType } from "./solvency.js";

/**
 * The persistence boundary. The pure ledger core depends only on this interface;
 * a memory adapter backs the fast algebraic properties, a Prisma/Postgres adapter
 * backs the persistence + concurrency properties. Prisma types never leak past here.
 */
export interface LedgerStore {
  /**
   * Append a balanced entry atomically. Idempotent on `entry.idempotencyKey`:
   * a repeat key returns `{ applied: false }` and writes nothing.
   */
  append(entry: JournalEntry): Promise<{ applied: boolean }>;

  /** Signed netted balance (DEBIT positive) for one account+asset. */
  balance(account: LedgerAccountKey, asset: Asset): Promise<bigint>;

  /** All postings for an account+asset — the source of truth balances reconcile against. */
  postingsFor(account: LedgerAccountKey, asset: Asset): Promise<readonly Posting[]>;

  /** Per-type, per-asset magnitudes for the solvency invariant. */
  totalsByType(): Promise<TotalsByType>;
}
