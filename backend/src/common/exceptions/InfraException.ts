import type { InfraErrorCode } from "@/types";
import { AppError } from "./AppException.js";

export abstract class InfraException extends AppError {
  abstract override readonly code: InfraErrorCode;
}

export class SigningKeyUnavailableError extends InfraException {
  readonly code = "SIGNING_KEY_UNAVAILABLE";
}

export class DatabaseNotConfiguredError extends InfraException {
  readonly code = "DATABASE_NOT_CONFIGURED";

  constructor() {
    super(
      "No database URL configured. Set DATABASE_URL (or DB_URL) to a Postgres connection string.",
    );
  }
}

export class DatabasePlaceholderUrlError extends InfraException {
  readonly code = "DATABASE_PLACEHOLDER_URL";

  constructor(variable: string, redactedUrl: string) {
    super(
      `${variable} still contains a placeholder from .env.example (${redactedUrl}). Replace it with your real connection string.`,
      { context: { variable } },
    );
  }
}
