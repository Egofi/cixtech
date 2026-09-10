import type { ErrorRecord, ErrorResponseBody, ErrorSeverity, ResolvedError } from "@/types";
import { AppError, toErrorRecord } from "../exceptions/AppException.js";
import { policyFor } from "./catalogue.js";
import type { ErrorSink } from "./sink.js";

interface ValidationLike {
  validation?: unknown;
  statusCode?: number;
  code?: string;
}

const asValidationLike = (err: unknown): ValidationLike =>
  typeof err === "object" && err !== null ? (err as ValidationLike) : {};

export function resolveError(err: unknown): ResolvedError {
  const record = toErrorRecord(err);

  if (err instanceof AppError) {
    return finish(err.status, record, err.toPublic());
  }

  const raw = asValidationLike(err);

  if (raw.validation !== undefined) {
    const policy = policyFor("VALIDATION");
    const message = err instanceof Error ? err.message : "Request failed validation";
    return finish(
      policy.status,
      { ...record, code: "VALIDATION", severity: policy.severity },
      {
        id: record.id,
        code: "VALIDATION",
        message,
      },
    );
  }

  const status = typeof raw.statusCode === "number" ? raw.statusCode : 500;

  if (status >= 400 && status < 500) {
    const code = typeof raw.code === "string" ? raw.code : "BAD_REQUEST";
    const message = err instanceof Error ? err.message : String(err);
    return finish(status, { ...record, code }, { id: record.id, code, message });
  }

  return finish(500, record, { id: record.id, code: "INTERNAL", message: "Internal error" });
}

function finish(
  status: number,
  record: ErrorRecord,
  publicError: ErrorResponseBody["error"],
): ResolvedError {
  return {
    status,
    severity: record.severity,
    record,
    body: { error: publicError },
    persist: record.severity !== "expected",
  };
}

export function notFoundResponse(method: string, url: string): ResolvedError {
  const record = toErrorRecord(new Error(`Route ${method}:${url} not found`));
  const policy = policyFor("NOT_FOUND");
  return finish(
    policy.status,
    { ...record, code: "NOT_FOUND", severity: policy.severity },
    { id: record.id, code: "NOT_FOUND", message: `Route ${method}:${url} not found` },
  );
}

export interface ErrorEntranceOptions {
  sink: ErrorSink;
  onCritical?: (record: ErrorRecord) => void;
}

export async function handleError(
  err: unknown,
  { sink, onCritical }: ErrorEntranceOptions,
): Promise<ResolvedError> {
  const resolved = resolveError(err);
  if (resolved.persist) await sink.capture(resolved.record);
  if (resolved.severity === "critical") onCritical?.(resolved.record);
  return resolved;
}
