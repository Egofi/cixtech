import type { ApiErrorCode } from "@/types";
import { AppError } from "./AppException.js";

export abstract class ApiException extends AppError {
  abstract override readonly code: ApiErrorCode;
}

export class UnauthorizedError extends ApiException {
  readonly code = "UNAUTHORIZED";
}

export class ForbiddenScopeError extends ApiException {
  readonly code = "FORBIDDEN_SCOPE";
}

export class InvalidScopesError extends ApiException {
  readonly code = "INVALID_SCOPES";
}

export class AccountNotFoundError extends ApiException {
  readonly code = "ACCOUNT_NOT_FOUND";
}

export class InvalidDestinationError extends ApiException {
  readonly code = "INVALID_DESTINATION";
}

export class UnsafeWebhookUrlError extends ApiException {
  readonly code = "UNSAFE_WEBHOOK_URL";
}
