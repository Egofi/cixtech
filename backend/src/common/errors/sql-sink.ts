import { kyselyFor } from "@/postgres";
import { errorLog } from "@/queries";
import type { Db, ErrorRecord, SqlClient } from "@/types";
import type { ErrorSink } from "./sink.js";

export class SqlErrorSink implements ErrorSink {
  private readonly db: Db;

  constructor(sql: SqlClient) {
    this.db = kyselyFor(sql);
  }

  async capture(record: ErrorRecord): Promise<void> {
    try {
      await errorLog
        .capture(this.db, {
          id: record.id,
          code: record.code,
          message: record.message,
          context: JSON.stringify(record.context ?? {}),
          at: new Date(record.occurredAt),
        })
        .execute();
    } catch (err) {
      console.error("SqlErrorSink.capture failed", err);
    }
  }
}
