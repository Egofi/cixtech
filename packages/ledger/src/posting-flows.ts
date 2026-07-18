import type { Asset, IdempotencyKey, JournalEntryId, LedgerAccountKey } from "@cixtech/types";
import { InvalidPostingError, assertBalanced } from "./balanced.js";
import { type JournalEntry, type Posting, flip } from "./entry.js";

const BPS_DENOMINATOR = 10_000n;

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
 * Split a gross deposit into the platform fee (floored) and the merchant's
 * remainder, in integer base units. Floored fee + remainder is *exactly* the
 * gross, so no base unit is ever lost or invented (property 3); flooring the fee
 * rounds in the merchant's favour, never ours.
 */
export function splitFee(amount: bigint, feeBasisPoints: number): { fee: bigint; net: bigint } {
  if (amount <= 0n) {
    throw new InvalidPostingError(`Deposit amount must be positive, got ${amount}`);
  }
  if (!Number.isInteger(feeBasisPoints) || feeBasisPoints < 0 || feeBasisPoints >= 10_000) {
    throw new InvalidPostingError(
      `feeBasisPoints must be an integer in [0, 10000), got ${feeBasisPoints}`,
    );
  }
  const fee = (amount * BigInt(feeBasisPoints)) / BPS_DENOMINATOR; // floor, since bigint division truncates
  return { fee, net: amount - fee };
}

/**
 * Credit a confirmed deposit at finality (ADR 0010). The whole gross lands in the
 * merchant's pool address (ASSET, debit); the liability we owe the merchant
 * (`merchant_available`, credit) plus our recognized fee (`egofi_fee_revenue`,
 * credit) sum back to the gross. A zero fee (small ticket rounds to 0) omits the
 * fee leg so no zero-amount posting is created.
 *
 * Satisfies:
 *   merchant_available + egofi_fee_revenue == amount              (property 3, exact)
 *   pool_addr == merchant_available + egofi_fee_revenue           (ADR 0009 identity)
 */
export function depositFinalized(input: DepositFinalizedInput): JournalEntry {
  const { fee, net } = splitFee(input.amount, input.feeBasisPoints);

  const postings: Posting[] = [
    { account: input.poolAddr, asset: input.asset, amount: input.amount, direction: "DEBIT" },
    { account: input.merchantAvailable, asset: input.asset, amount: net, direction: "CREDIT" },
  ];
  if (fee > 0n) {
    postings.push({
      account: input.feeRevenue,
      asset: input.asset,
      amount: fee,
      direction: "CREDIT",
    });
  }

  const entry: JournalEntry = {
    id: input.id,
    idempotencyKey: input.idempotencyKey,
    kind: "deposit.finalized",
    postings,
    occurredAt: input.occurredAt ?? new Date(),
  };
  assertBalanced(entry);
  return entry;
}

export interface PayoutLockedInput {
  id: JournalEntryId;
  idempotencyKey: IdempotencyKey;
  asset: Asset;
  amount: bigint;
  merchantAvailable: LedgerAccountKey;
  merchantPendingWithdrawal: LedgerAccountKey;
  occurredAt?: Date;
}

/**
 * Lock funds when a merchant requests a payout (ADR 0010): reclassify the
 * liability we owe from `merchant_available` (DEBIT) to
 * `merchant_pending_withdrawal` (CREDIT). Total liability is unchanged — the
 * money is still owed to the merchant, just earmarked. The available-balance
 * GUARD lives in `LedgerService.lockPayout`, not here (a builder stays pure).
 */
export function payoutLocked(input: PayoutLockedInput): JournalEntry {
  if (input.amount <= 0n) {
    throw new InvalidPostingError(`Payout amount must be positive, got ${input.amount}`);
  }
  const entry: JournalEntry = {
    id: input.id,
    idempotencyKey: input.idempotencyKey,
    kind: "payout.locked",
    postings: [
      {
        account: input.merchantAvailable,
        asset: input.asset,
        amount: input.amount,
        direction: "DEBIT",
      },
      {
        account: input.merchantPendingWithdrawal,
        asset: input.asset,
        amount: input.amount,
        direction: "CREDIT",
      },
    ],
    occurredAt: input.occurredAt ?? new Date(),
  };
  assertBalanced(entry);
  return entry;
}

// ── deposit detected / payout settled / fee swept ──────────────────────────────
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
