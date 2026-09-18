import type { ChainErrorCode } from "@/types";
import { AppError } from "./AppException.js";

export abstract class ChainException extends AppError {
  abstract override readonly code: ChainErrorCode;
}

export class UnsupportedChainError extends ChainException {
  readonly code = "UNSUPPORTED_CHAIN";
}

export class ChainMisconfiguredError extends ChainException {
  readonly code = "CHAIN_MISCONFIGURED";
}

export class InvalidAuthorizationError extends ChainException {
  readonly code = "AUTHORIZATION_INVALID";
}

export class TronTxMismatchError extends ChainException {
  readonly code = "TRON_TX_MISMATCH";
}

export class PolicyDeniedError extends ChainException {
  readonly code = "POLICY_DENIED";
}

export class ApprovalRequiredError extends ChainException {
  readonly code = "POLICY_APPROVAL_REQUIRED";
}

export class TimeLockedError extends ChainException {
  readonly code = "POLICY_TIME_LOCKED";
}

export class ComplianceHoldError extends ChainException {
  readonly code = "POLICY_COMPLIANCE_HOLD";
}

export class SelfApprovalError extends ChainException {
  readonly code = "POLICY_SELF_APPROVAL";
}

export class WithdrawalNotFoundError extends ChainException {
  readonly code = "WITHDRAWAL_NOT_FOUND";
}

export class FeeTreasuryNotConfiguredError extends ChainException {
  readonly code = "FEE_TREASURY_NOT_CONFIGURED";
}

export class SweepHaltedError extends ChainException {
  readonly code = "SWEEP_HALTED";
}

/**
 * The gas treasury cannot cover the fee for a token transfer. Temporary and
 * fixable by topping it up, so it is retryable — and not exposable, because the
 * size of our gas float is not a tenant's business.
 */
export class GasFloatDepletedError extends ChainException {
  readonly code = "GAS_FLOAT_DEPLETED";
}

/** No gas treasury is configured at all — a deployment fault, not a transient one. */
export class GasTreasuryNotConfiguredError extends ChainException {
  readonly code = "GAS_TREASURY_NOT_CONFIGURED";
}
