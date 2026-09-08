import { randomUUID } from "node:crypto";

/** The persisted, audit-safe shape of any error (ADR 0012). This is what lands in the store. */
export interface ErrorRecord {
  /** Stable correlation id, quotable by support and joinable to logs and the action audit trail. */
  id: string;
  code: string;
  name: string;
  message: string;
  context: Record<string, unknown>;
  occurredAt: string;
  /** Whether `message` is safe to return to an external caller. */
  exposable: boolean;
  stack?: string;
  cause?: string;
}

export interface AppErrorOptions {
  /** Structured, non-sensitive details for the audit record (bigints must be pre-stringified). */
  context?: Record<string, unknown>;
  cause?: unknown;
  /** Whether `message` may be shown to an external caller. Defaults to true. */
  exposable?: boolean;
}

/**
 * Base class for every domain error. Assigns a stable `id` at construction so the
 * error can be surfaced to the caller AND persisted for audit under the same id
 * (ADR 0012). Subclasses supply a machine-readable `code`.
 */
export abstract class AppError extends Error {
  readonly id: string;
  readonly occurredAt: Date;
  readonly context: Record<string, unknown>;
  readonly exposable: boolean;
  abstract readonly code: string;

  constructor(message: string, options: AppErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.id = randomUUID();
    this.occurredAt = new Date();
    this.context = options.context ?? {};
    this.exposable = options.exposable ?? true;
    this.name = new.target.name;
  }

  /** Full record for the audit sink — includes stack and context. Never returned to callers. */
  toRecord(): ErrorRecord {
    return {
      id: this.id,
      code: this.code,
      name: this.name,
      message: this.message,
      context: this.context,
      occurredAt: this.occurredAt.toISOString(),
      exposable: this.exposable,
      ...(this.stack ? { stack: this.stack } : {}),
      ...(this.cause !== undefined ? { cause: String(this.cause) } : {}),
    };
  }

  /** Audit-safe projection for an external caller. Leaks neither stack nor context. */
  toPublic(): { id: string; code: string; message: string } {
    return {
      id: this.id,
      code: this.code,
      message: this.exposable ? this.message : "An internal error occurred",
    };
  }
}

/**
 * Normalize ANY thrown value into an ErrorRecord — so even a stray plain Error or
 * a thrown string still gets an id and is auditable (the "every error" guarantee).
 * Unclassified errors are never exposable.
 */
export function toErrorRecord(err: unknown): ErrorRecord {
  if (err instanceof AppError) return err.toRecord();
  const e = err instanceof Error ? err : new Error(String(err));
  return {
    id: randomUUID(),
    code: "UNCLASSIFIED",
    name: e.name,
    message: e.message,
    context: {},
    occurredAt: new Date().toISOString(),
    exposable: false,
    ...(e.stack ? { stack: e.stack } : {}),
  };
}
