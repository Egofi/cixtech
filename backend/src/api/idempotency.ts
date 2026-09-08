import type { SqlClient } from "@/ledger";

export interface StoredResponse {
  status: number;
  body: unknown;
}

/**
 * DB-backed idempotency with the reserve-then-store pattern. `begin` atomically
 * reserves the key (INSERT … ON CONFLICT DO NOTHING); the first caller gets
 * `null` and must process, then `complete`. A concurrent/repeat caller gets the
 * stored response, or an in-progress marker if the first is still running. A
 * failed request calls `release` so a retry can proceed.
 */
export class IdempotencyStore {
  constructor(private readonly sql: SqlClient) {}

  async begin(tenantId: string, key: string): Promise<StoredResponse | null> {
    const reserved = await this.sql.query<{ key: string }>(
      `INSERT INTO idempotency_key (tenant_id, key) VALUES ($1, $2)
       ON CONFLICT (tenant_id, key) DO NOTHING RETURNING key`,
      [tenantId, key],
    );
    if (reserved.rows.length > 0) return null; // we reserved it — first time through

    const r = await this.sql.query<{ status: number | null; response: string | null }>(
      "SELECT status, response FROM idempotency_key WHERE tenant_id = $1 AND key = $2",
      [tenantId, key],
    );
    const row = r.rows[0];
    if (!row || row.response === null) {
      return {
        status: 409,
        body: { error: { code: "IN_PROGRESS", message: "request in progress" } },
      };
    }
    return { status: Number(row.status), body: JSON.parse(row.response) };
  }

  async complete(tenantId: string, key: string, status: number, body: unknown): Promise<void> {
    await this.sql.query(
      "UPDATE idempotency_key SET status = $3, response = $4 WHERE tenant_id = $1 AND key = $2",
      [tenantId, key, status, JSON.stringify(body)],
    );
  }

  /** Drop the reservation so a failed request can be retried with the same key. */
  async release(tenantId: string, key: string): Promise<void> {
    await this.sql.query("DELETE FROM idempotency_key WHERE tenant_id = $1 AND key = $2", [
      tenantId,
      key,
    ]);
  }
}
