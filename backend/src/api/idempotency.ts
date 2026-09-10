import { kyselyFor } from "@/postgres";
import { idempotencyKey } from "@/queries";
import type { Db, SqlClient, StoredResponse } from "@/types";

export class IdempotencyStore {
  private readonly db: Db;

  constructor(sql: SqlClient) {
    this.db = kyselyFor(sql);
  }

  async begin(tenantId: string, key: string): Promise<StoredResponse | null> {
    const reserved = await idempotencyKey.claim(this.db, tenantId, key).execute();
    if (reserved.length > 0) return null;

    const row = await idempotencyKey.load(this.db, tenantId, key).executeTakeFirst();
    if (!row || row.response === null) {
      return {
        status: 409,
        body: { error: { code: "IN_PROGRESS", message: "request in progress" } },
      };
    }
    return { status: Number(row.status), body: JSON.parse(row.response) };
  }

  async complete(tenantId: string, key: string, status: number, body: unknown): Promise<void> {
    await idempotencyKey.complete(this.db, tenantId, key, status, JSON.stringify(body)).execute();
  }

  async release(tenantId: string, key: string): Promise<void> {
    await idempotencyKey.release(this.db, tenantId, key).execute();
  }
}
