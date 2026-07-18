import type { Asset, LedgerAccountKey } from "@cixtech/types";
import type { JournalEntry, Posting } from "../entry.js";
import type { LedgerStore } from "../ledger.port.js";
import type { TotalsByType } from "../solvency.js";

/**
 * Postgres-backed LedgerStore for the persistence + concurrency property suites
 * (properties 10–12), exercised against a testcontainers Postgres.
 *
 * TODO(step1): implement over Prisma with:
 *   - append(): postings + balance upsert in ONE transaction; UNIQUE(idempotencyKey)
 *     so a racing duplicate collapses to exactly one set of postings (property 11);
 *   - optimistic `version` on the balance row so concurrent appends never lose an
 *     update (property 10).
 * Prisma types must not escape this file (ledger core stays framework-free).
 */
export class PrismaLedgerStore implements LedgerStore {
  append(_entry: JournalEntry): Promise<{ applied: boolean }> {
    throw new Error("TODO(step1): implement PrismaLedgerStore.append (atomic + idempotent)");
  }
  balance(_account: LedgerAccountKey, _asset: Asset): Promise<bigint> {
    throw new Error("TODO(step1): implement PrismaLedgerStore.balance");
  }
  postingsFor(_account: LedgerAccountKey, _asset: Asset): Promise<readonly Posting[]> {
    throw new Error("TODO(step1): implement PrismaLedgerStore.postingsFor");
  }
  totalsByType(): Promise<TotalsByType> {
    throw new Error("TODO(step1): implement PrismaLedgerStore.totalsByType");
  }
}
