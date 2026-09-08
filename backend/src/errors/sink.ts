import { type ErrorRecord, toErrorRecord } from "./app-error.js";

/**
 * Persistence boundary for the error-audit trail (ADR 0012). The API and worker
 * layers write every caught error here. A Postgres-backed sink lands with the
 * ledger's persistence layer; the pure core depends only on this interface.
 */
export interface ErrorSink {
  capture(record: ErrorRecord): Promise<void>;
}

/** In-memory sink for tests and local dev. */
export class InMemoryErrorSink implements ErrorSink {
  readonly records: ErrorRecord[] = [];
  async capture(record: ErrorRecord): Promise<void> {
    this.records.push(record);
  }
}

/**
 * Assign an id (if not already one), persist the audit record, and return it so
 * the caller can surface `record.id`. This is the single choke point every error
 * path should flow through.
 */
export async function captureError(sink: ErrorSink, err: unknown): Promise<ErrorRecord> {
  const record = toErrorRecord(err);
  await sink.capture(record);
  return record;
}
