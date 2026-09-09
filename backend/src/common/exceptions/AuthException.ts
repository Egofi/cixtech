import type { AuthErrorCode } from "@/types";
import { AppError } from "./AppException.js";

export abstract class AuthException extends AppError {
  abstract override readonly code: AuthErrorCode;
}

export class AuthError extends AuthException {
  readonly code = "AUTH_FAILED";
}

export class AccountLockedError extends AuthException {
  readonly code = "ACCOUNT_LOCKED";
}

export class MfaRequiredError extends AuthException {
  readonly code = "MFA_REQUIRED";
}

export class MfaEnrolmentRequiredError extends AuthException {
  readonly code = "MFA_ENROLMENT_REQUIRED";
}

export class PrincipalExistsError extends AuthException {
  readonly code = "PRINCIPAL_EXISTS";
}

export class PrincipalNotFoundError extends AuthException {
  readonly code = "PRINCIPAL_NOT_FOUND";
}

export class InvalidRoleError extends AuthException {
  readonly code = "INVALID_ROLE";
}

export class NotAuthenticatedError extends AuthException {
  readonly code = "NOT_AUTHENTICATED";
}

export class ForbiddenError extends AuthException {
  readonly code = "FORBIDDEN";
}

export class CsrfError extends AuthException {
  readonly code = "CSRF_FAILED";
}

export class PasswordChangeRequiredError extends AuthException {
  readonly code = "PASSWORD_CHANGE_REQUIRED";
}
