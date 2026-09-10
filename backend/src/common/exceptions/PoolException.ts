import type { PoolErrorCode } from "@/types";
import { AppError } from "./AppException.js";

export abstract class PoolException extends AppError {
  abstract override readonly code: PoolErrorCode;
}

export class InsufficientPoolFundsError extends PoolException {
  readonly code = "POOL_INSUFFICIENT_FUNDS";
}

export class PoolAddressNotFoundError extends PoolException {
  readonly code = "POOL_ADDRESS_NOT_FOUND";
}

export class PoolConcurrentModificationError extends PoolException {
  readonly code = "POOL_CONCURRENT_MODIFICATION";
}

export class InvalidPoolTransitionError extends PoolException {
  readonly code = "POOL_INVALID_TRANSITION";
}

export class GatherBusyError extends PoolException {
  readonly code = "GATHER_BUSY";
}

export class UnknownGatherStrategyError extends PoolException {
  readonly code = "GATHER_STRATEGY_UNKNOWN";
}

export class GatherStrategyNotSupportedError extends PoolException {
  readonly code = "GATHER_STRATEGY_NOT_SUPPORTED";
}
