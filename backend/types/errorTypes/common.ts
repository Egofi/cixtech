export type ErrorSeverity = "expected" | "warning" | "critical";

export interface ErrorPolicy {
  status: number;
  severity: ErrorSeverity;
  exposable: boolean;
  retryable: boolean;
}

export interface ErrorRecord {
  id: string;
  code: string;
  name: string;
  message: string;
  context: Record<string, unknown>;
  occurredAt: string;
  severity: ErrorSeverity;
  exposable: boolean;
  stack?: string;
  cause?: string;
}

export interface PublicError {
  id: string;
  code: string;
  message: string;
}

export interface ErrorResponseBody {
  error: PublicError;
}

export interface AppErrorOptions {
  context?: Record<string, unknown>;
  cause?: unknown;
  exposable?: boolean;
}
