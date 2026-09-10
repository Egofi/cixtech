import type { AccountType } from "../enums/account-type.js";
import type { LedgerAccountKey } from "./account.js";
import type { IdempotencyKey, JournalEntryId } from "./ids.js";
import type { Asset } from "./money.js";

export interface DriftRow {
  account: LedgerAccountKey;
  asset: Asset;
  materialized: bigint;
  fromHistory: bigint;
}

export interface DepositFinalizedInput {
  id: JournalEntryId;
  idempotencyKey: IdempotencyKey;
  asset: Asset;
  amount: bigint;
  feeBasisPoints: number;
  poolAddr: LedgerAccountKey;
  merchantAvailable: LedgerAccountKey;
  feeRevenue: LedgerAccountKey;
  occurredAt?: Date;
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

export interface NetworkFeeLeg {
  asset: Asset;
  amount: bigint;
  gasFloat: LedgerAccountKey;
  expense: LedgerAccountKey;
}

export interface PayoutSettledInput {
  id: JournalEntryId;
  idempotencyKey: IdempotencyKey;
  asset: Asset;
  amount: bigint;
  merchantPendingWithdrawal: LedgerAccountKey;
  poolAddr: LedgerAccountKey;

  networkFee?: NetworkFeeLeg;
  occurredAt?: Date;
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

export interface DepositDetectedInput {
  id: JournalEntryId;
  idempotencyKey: IdempotencyKey;
  asset: Asset;
  amount: bigint;
  poolAddrUnconfirmed: LedgerAccountKey;
  merchantPending: LedgerAccountKey;
  occurredAt?: Date;
}

export interface DepositQuarantinedInput {
  id: JournalEntryId;
  idempotencyKey: IdempotencyKey;
  asset: Asset;
  amount: bigint;
  poolAddr: LedgerAccountKey;
  complianceSuspense: LedgerAccountKey;
  occurredAt?: Date;
}

export interface DepositReleasedInput {
  id: JournalEntryId;
  idempotencyKey: IdempotencyKey;
  asset: Asset;
  amount: bigint;
  fee: bigint;
  complianceSuspense: LedgerAccountKey;
  merchantAvailable: LedgerAccountKey;
  feeRevenue: LedgerAccountKey;
  occurredAt?: Date;
}

export type Direction = "DEBIT" | "CREDIT";

export interface Posting {
  readonly account: LedgerAccountKey;
  readonly asset: Asset;
  readonly amount: bigint;
  readonly direction: Direction;
}

export interface JournalEntry {
  readonly id: JournalEntryId;
  readonly idempotencyKey: IdempotencyKey;
  readonly kind: string;
  readonly postings: readonly Posting[];
  readonly occurredAt: Date;
}

export type TotalsByType = Map<AccountType, Map<string, bigint>>;

export interface AssetSolvency {
  readonly asset: string;
  readonly assets: bigint;
  readonly liabilities: bigint;
}
