import type { MpcErrorCode } from "@/types";
import { AppError } from "./AppException.js";

export abstract class MpcException extends AppError {
  abstract override readonly code: MpcErrorCode;
}

export class NodeRejectedError extends MpcException {
  readonly code = "MPC_NODE_REJECTED";
}

export class ThresholdNotMetError extends MpcException {
  readonly code = "MPC_THRESHOLD_NOT_MET";
}

export class BadContributionError extends MpcException {
  readonly code = "MPC_BAD_CONTRIBUTION";
}

export class InterimForbiddenError extends MpcException {
  readonly code = "MPC_INTERIM_FORBIDDEN";
}
