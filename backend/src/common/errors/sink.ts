import type { ErrorRecord } from "@/types";
import { toErrorRecord } from "../exceptions/AppException.js";

export interface ErrorSink {
  capture(record: ErrorRecord): Promise<void>;
}

export class InMemoryErrorSink implements ErrorSink {
  readonly records: ErrorRecord[] = [];
  async capture(record: ErrorRecord): Promise<void> {
    this.records.push(record);
  }
}

export async function captureError(sink: ErrorSink, err: unknown): Promise<ErrorRecord> {
  const record = toErrorRecord(err);
  await sink.capture(record);
  return record;
}
