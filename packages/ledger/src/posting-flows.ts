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

/** Optional network-fee leg, in a (usually native) gas asset, balanced on its own. */
export interface NetworkFeeLeg {
  asset: Asset;
  amount: bigint;
  gasFloat: LedgerAccountKey;
  expense: LedgerAccountKey;
}

function networkFeePostings(fee: NetworkFeeLeg | undefined): Posting[] {
  if (!fee || fee.amount <= 0n) return [];
  return [
    { account: fee.expense, asset: fee.asset, amount: fee.amount, direction: "DEBIT" },
    { account: fee.gasFloat, asset: fee.asset, amount: fee.amount, direction: "CREDIT" },
  ];
}

export interface PayoutSettledInput {
  id: JournalEntryId;
  idempotencyKey: IdempotencyKey;
  asset: Asset;
  amount: bigint;
  merchantPendingWithdrawal: LedgerAccountKey;
  poolAddr: LedgerAccountKey;
  /** Gas burned to send the payout, in a separate asset. Balanced independently. */
  networkFee?: NetworkFeeLeg;
  occurredAt?: Date;
}

/**
 * Settle a locked payout on-chain (ADR 0010): the earmarked liability is
 * discharged and the funds physically leave the pool. This is the ONLY time the
 * payout asset leaves custody. The gas leg (if any) is a separate asset and
 * balances on its own.
 */
export function payoutSettled(input: PayoutSettledInput): JournalEntry {
  if (input.amount <= 0n) {
    throw new InvalidPostingError(`Payout amount must be positive, got ${input.amount}`);
  }
  const entry: JournalEntry = {
    id: input.id,
    idempotencyKey: input.idempotencyKey,
    kind: "payout.settled",
    postings: [
      {
        account: input.merchantPendingWithdrawal,
        asset: input.asset,
        amount: input.amount,
        direction: "DEBIT",
      },
      { account: input.poolAddr, asset: input.asset, amount: input.amount, direction: "CREDIT" },
      ...networkFeePostings(input.networkFee),
    ],
    occurredAt: input.occurredAt ?? new Date(),
  };
  assertBalanced(entry);
  return entry;
}

export interface FeeSweptInput {
  id: JournalEntryId;
  idempotencyKey: IdempotencyKey;
  asset: Asset;
  amount: bigint;
  poolAddr: LedgerAccountKey;
  treasury: LedgerAccountKey;
  networkFee?: NetworkFeeLeg;
  occurredAt?: Date;
}

/**
 * Sweep accrued fee revenue out of the scattered pool addresses into treasury
 * (ADR 0010). Revenue was already recognized at deposit finality, so this only
 * RELOCATES the asset — it does not touch `egofi_fee_revenue`. Conservation is
 * preserved: pool falls by exactly what treasury gains.
 */
export function feeSwept(input: FeeSweptInput): JournalEntry {
  if (input.amount <= 0n) {
    throw new InvalidPostingError(`Fee sweep amount must be positive, got ${input.amount}`);
  }
  const entry: JournalEntry = {
    id: input.id,
    idempotencyKey: input.idempotencyKey,
    kind: "fee.swept",
    postings: [
      { account: input.treasury, asset: input.asset, amount: input.amount, direction: "DEBIT" },
      { account: input.poolAddr, asset: input.asset, amount: input.amount, direction: "CREDIT" },
      ...networkFeePostings(input.networkFee),
    ],
    occurredAt: input.occurredAt ?? new Date(),
  };
  assertBalanced(entry);
  return entry;
}

export interface DepositDetectedInput {
  id: JournalEntryId;
  idempotencyKey: IdempotencyKey;
  asset: Asset;
  amount: bigint;
  poolAddrUnconfirmed: LedgerAccountKey;
  merchantPending: LedgerAccountKey;
  occurredAt?: Date;
}

/**
 * Record a seen-but-not-yet-final deposit (ADR 0010): the value sits in an
 * `pool_addr_unconfirmed` asset against a `merchant_pending` liability. At
 * finality this is reversed and `depositFinalized` credits the confirmed state;
 * a reorg before finality is just `reverse()` of this entry.
 */
export function depositDetected(input: DepositDetectedInput): JournalEntry {
  if (input.amount <= 0n) {
    throw new InvalidPostingError(`Deposit amount must be positive, got ${input.amount}`);
  }
  const entry: JournalEntry = {
    id: input.id,
    idempotencyKey: input.idempotencyKey,
    kind: "deposit.detected",
    postings: [
      {
        account: input.poolAddrUnconfirmed,
        asset: input.asset,
        amount: input.amount,
        direction: "DEBIT",
      },
      {
        account: input.merchantPending,
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

export interface DepositQuarantinedInput {
  id: JournalEntryId;
  idempotencyKey: IdempotencyKey;
  asset: Asset;
  amount: bigint; // gross base units received
  poolAddr: LedgerAccountKey;
  complianceSuspense: LedgerAccountKey;
  occurredAt?: Date;
}

/**
 * Credit a KYT/sanctions-flagged deposit into `compliance_suspense` instead of the
 * merchant (build spec §14). The value physically lands in the pool address
 * (ASSET, debit) but the offsetting liability is held in `compliance_suspense`
 * (credit), NOT `merchant_available` — so flagged funds are provably held, never
 * spendable by the merchant, until a compliance decision releases or returns them.
 * No fee is recognized on quarantined value.
 */
export function depositQuarantined(input: DepositQuarantinedInput): JournalEntry {
  if (input.amount <= 0n) {
    throw new InvalidPostingError(`Deposit amount must be positive, got ${input.amount}`);
  }
  const entry: JournalEntry = {
    id: input.id,
    idempotencyKey: input.idempotencyKey,
    kind: "deposit.quarantined",
    postings: [
      { account: input.poolAddr, asset: input.asset, amount: input.amount, direction: "DEBIT" },
      {
        account: input.complianceSuspense,
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

export interface DepositReleasedInput {
  id: JournalEntryId;
  idempotencyKey: IdempotencyKey;
  asset: Asset;
  amount: bigint; // net to release to the merchant (gross − fee)
  fee: bigint; // fee recognized on release, may be 0
  complianceSuspense: LedgerAccountKey;
  merchantAvailable: LedgerAccountKey;
  feeRevenue: LedgerAccountKey;
  occurredAt?: Date;
}

/**
 * Release previously quarantined funds after a compliance clear (build spec §14):
 * move the held liability out of `compliance_suspense` (DEBIT) into
 * `merchant_available` (CREDIT) plus the recognized fee (CREDIT). Total liability
 * is unchanged; the funds simply become the merchant's and spendable. `net + fee`
 * must equal the released `amount + fee` that was held.
 */
export function depositReleased(input: DepositReleasedInput): JournalEntry {
  if (input.amount <= 0n) {
    throw new InvalidPostingError(`Release amount must be positive, got ${input.amount}`);
  }
  if (input.fee < 0n) {
    throw new InvalidPostingError(`Release fee must be non-negative, got ${input.fee}`);
  }
  const gross = input.amount + input.fee;
  const postings: Posting[] = [
    {
      account: input.complianceSuspense,
      asset: input.asset,
      amount: gross,
      direction: "DEBIT",
    },
    {
      account: input.merchantAvailable,
      asset: input.asset,
      amount: input.amount,
      direction: "CREDIT",
    },
  ];
  if (input.fee > 0n) {
    postings.push({
      account: input.feeRevenue,
      asset: input.asset,
      amount: input.fee,
      direction: "CREDIT",
    });
  }
  const entry: JournalEntry = {
    id: input.id,
    idempotencyKey: input.idempotencyKey,
    kind: "deposit.released",
    postings,
    occurredAt: input.occurredAt ?? new Date(),
  };
  assertBalanced(entry);
  return entry;
}

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
