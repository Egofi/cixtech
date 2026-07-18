import type { Asset, IdempotencyKey, JournalEntryId, LedgerAccountKey } from "@cixtech/types";
import { assertBalanced } from "./balanced.js";
import { type JournalEntry, type Posting, flip } from "./entry.js";

/**
 * Pure `event → JournalEntry` builders for the ADR 0010 money flows. Each returns
 * a balanced entry or throws. NONE of these touch a chain or a key — they only
 * produce postings; persistence is the LedgerService's job.
 *
 * TODO(step1): implement the remaining builders + property-test each against the
 * flows in ADR 0010. `reverse` is implemented as the template.
 */

export interface DepositFinalizedInput {
  id: JournalEntryId;
  idempotencyKey: IdempotencyKey;
  asset: Asset;
  amount: bigint; // gross base units received
  feeBasisPoints: number; // e.g. 50 = 0.50%
  poolAddr: LedgerAccountKey;
  merchantAvailable: LedgerAccountKey;
  feeRevenue: LedgerAccountKey;
  occurredAt?: Date;
}

/**
 * Credit a confirmed deposit, splitting the fee. Must satisfy, exactly:
 *   merchant_available + egofi_fee_revenue == amount   (no base-unit leak)
 * TODO(step1): implement integer fee math (floor fee, remainder to merchant),
 * then property 3 (decimal precision) and property 9 (pool identity) pin it.
 */
export function depositFinalized(_input: DepositFinalizedInput): JournalEntry {
  throw new Error("TODO(step1): implement depositFinalized per ADR 0010");
}

// ── deposit detected / payout locked / payout settled / fee swept ──────────────
// TODO(step1): implement each as a balanced builder; see ADR 0010 posting table.

/** Reverse a prior entry (reorg / compensation). Flips every posting's direction. */
export function reverse(
  entry: JournalEntry,
  newId: JournalEntryId,
  newKey: IdempotencyKey,
  occurredAt: Date = new Date(),
): JournalEntry {
  const postings: Posting[] = entry.postings.map((p) => ({ ...p, direction: flip(p.direction) }));
  const reversed: JournalEntry = {
    id: newId,
    idempotencyKey: newKey,
    kind: `reverse:${entry.kind}`,
    postings,
    occurredAt,
  };
  assertBalanced(reversed); // a reversal of a balanced entry is always balanced
  return reversed;
}
