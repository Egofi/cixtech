import type { LedgerErrorCode } from "@/types";
import { AppError } from "./AppException.js";

export abstract class LedgerException extends AppError {
  abstract override readonly code: LedgerErrorCode;
}

export class InsufficientFundsError extends LedgerException {
  readonly code = "LEDGER_INSUFFICIENT_FUNDS";
}

export class UnknownEntryError extends LedgerException {
  readonly code = "LEDGER_UNKNOWN_ENTRY";
}

export class UnbalancedEntryError extends LedgerException {
  readonly code = "LEDGER_UNBALANCED_ENTRY";
}

export class InvalidPostingError extends LedgerException {
  readonly code = "LEDGER_INVALID_POSTING";
}

export class DuplicateEntryIdError extends LedgerException {
  readonly code = "LEDGER_DUPLICATE_ENTRY_ID";
}
