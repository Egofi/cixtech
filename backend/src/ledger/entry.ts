import type { Asset, IdempotencyKey, JournalEntryId, LedgerAccountKey } from "@/types";

export type Direction = "DEBIT" | "CREDIT";

/** A single leg of a journal entry. `amount` is always a positive base-unit bigint. */
export interface Posting {
  readonly account: LedgerAccountKey;
  readonly asset: Asset;
  readonly amount: bigint;
  readonly direction: Direction;
}

/**
 * An immutable, balanced group of postings written atomically. Idempotency-keyed
 * so a redelivered chain webhook or retried intent never double-posts (ADR 0010).
 */
export interface JournalEntry {
  readonly id: JournalEntryId;
  readonly idempotencyKey: IdempotencyKey;
  readonly kind: string;
  readonly postings: readonly Posting[];
  readonly occurredAt: Date;
}

export const flip = (d: Direction): Direction => (d === "DEBIT" ? "CREDIT" : "DEBIT");
