import { randomUUID } from "node:crypto";
import type {
  AppErrorOptions,
  ErrorCode,
  ErrorPolicy,
  ErrorRecord,
  ErrorSeverity,
  PublicError,
} from "@/types";
import { UNCLASSIFIED_POLICY, policyFor } from "../errors/catalogue.js";

const INTERNAL_MESSAGE = "An internal error occurred";

export abstract class AppError extends Error {
  readonly id: string;
  readonly occurredAt: Date;
  readonly context: Record<string, unknown>;
  readonly exposable: boolean;
  abstract readonly code: ErrorCode;

  constructor(message: string, options: AppErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.id = randomUUID();
    this.occurredAt = new Date();
    this.context = options.context ?? {};
    this.exposable = options.exposable ?? true;
    this.name = new.target.name;
  }

  get policy(): ErrorPolicy {
    return policyFor(this.code);
  }

  get status(): number {
    return this.policy.status;
  }

  get severity(): ErrorSeverity {
    return this.policy.severity;
  }

  get retryable(): boolean {
    return this.policy.retryable;
  }

  isExposable(): boolean {
    return this.policy.exposable && this.exposable;
  }

  toRecord(): ErrorRecord {
    return {
      id: this.id,
      code: this.code,
      name: this.name,
      message: this.message,
      context: this.context,
      occurredAt: this.occurredAt.toISOString(),
      severity: this.severity,
      exposable: this.isExposable(),
      ...(this.stack ? { stack: this.stack } : {}),
      ...(this.cause !== undefined ? { cause: String(this.cause) } : {}),
    };
  }

  toPublic(): PublicError {
    return {
      id: this.id,
      code: this.code,
      message: this.isExposable() ? this.message : INTERNAL_MESSAGE,
    };
  }
}

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
    severity: UNCLASSIFIED_POLICY.severity,
    exposable: UNCLASSIFIED_POLICY.exposable,
    ...(e.stack ? { stack: e.stack } : {}),
  };
}
