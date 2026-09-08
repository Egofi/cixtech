import type { ErrorRecord, ErrorSink } from "@/errors";
import type { SqlClient } from "@/ledger";

/**
 * SQL-backed error-audit sink (ADR 0012 + 0015): persists every captured error to
 * `error_log` so the admin console can query the trail. Capture must never throw
 * (it runs inside the error handler), so a write failure is swallowed to stderr.
 */
export class SqlErrorSink implements ErrorSink {
  constructor(private readonly sql: SqlClient) {}

  async capture(record: ErrorRecord): Promise<void> {
    try {
      await this.sql.query(
        `INSERT INTO error_log (id, code, message, context, at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (id) DO NOTHING`,
        [
          record.id,
          record.code,
          record.message,
          JSON.stringify(record.context ?? {}),
          record.occurredAt,
        ],
      );
    } catch (err) {
      // Last-resort: the audit sink itself failed; do not mask the original error.
      console.error("SqlErrorSink.capture failed", err);
    }
  }
}
