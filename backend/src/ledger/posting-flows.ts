import { InvalidPostingError } from "@/common";
import type {
  Asset,
  DepositDetectedInput,
  DepositFinalizedInput,
  DepositQuarantinedInput,
  DepositReleasedInput,
  FeeSweptInput,
  IdempotencyKey,
  JournalEntry,
  JournalEntryId,
  LedgerAccountKey,
  NetworkFeeLeg,
  PayoutLockedInput,
  PayoutSettledInput,
  Posting,
} from "@/types";
import { assertBalanced } from "./balanced.js";
import { flip } from "./entry.js";

const BPS_DENOMINATOR = 10_000n;

export function splitFee(amount: bigint, feeBasisPoints: number): { fee: bigint; net: bigint } {
  if (amount <= 0n) {
    throw new InvalidPostingError(`Deposit amount must be positive, got ${amount}`);
  }
  if (!Number.isInteger(feeBasisPoints) || feeBasisPoints < 0 || feeBasisPoints >= 10_000) {
    throw new InvalidPostingError(
      `feeBasisPoints must be an integer in [0, 10000), got ${feeBasisPoints}`,
    );
  }
  const fee = (amount * BigInt(feeBasisPoints)) / BPS_DENOMINATOR;
  return { fee, net: amount - fee };
}

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

function networkFeePostings(fee: NetworkFeeLeg | undefined): Posting[] {
  if (!fee || fee.amount <= 0n) return [];
  return [
    { account: fee.expense, asset: fee.asset, amount: fee.amount, direction: "DEBIT" },
    { account: fee.gasFloat, asset: fee.asset, amount: fee.amount, direction: "CREDIT" },
  ];
}

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
  assertBalanced(reversed);
  return reversed;
}
