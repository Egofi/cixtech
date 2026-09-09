import { randomUUID } from "node:crypto";
import { kyselyFor } from "@/postgres";
import { payoutIntent } from "@/queries";
import type { NewIntent, PayoutIntent, PayoutIntentStatus, SqlClient } from "@/types";

interface IntentRow {
  id: string;
  idempotency_key: string;
  tenant: string;
  merchant: string;
  chain: string;
  asset: string;
  amount_base_units: string;
  destination: string;
  from_address: string | null;
  tx_id: string | null;
  status: string;
  requested_by: string | null;
  created_at: Date;
}

const toIntent = (r: IntentRow): PayoutIntent => ({
  id: r.id,
  idempotencyKey: r.idempotency_key,
  tenant: r.tenant,
  merchant: r.merchant,
  chain: r.chain,
  asset: r.asset,
  amountBaseUnits: BigInt(r.amount_base_units),
  destination: r.destination,
  fromAddress: r.from_address,
  txId: r.tx_id,
  status: r.status as PayoutIntentStatus,
  requestedBy: r.requested_by,
  createdAt: new Date(r.created_at),
});

export class PayoutJournal {
  constructor(private readonly sql: SqlClient) {}

  async begin(i: NewIntent): Promise<PayoutIntent> {
    await payoutIntent
      .begin(kyselyFor(this.sql), {
        id: randomUUID(),
        idempotency_key: i.idempotencyKey,
        tenant: i.tenant,
        merchant: i.merchant,
        chain: i.chain,
        asset: i.asset,
        amount_base_units: i.amountBaseUnits.toString(),
        destination: i.destination,
        requested_by: i.requestedBy ?? null,
      })
      .execute();
    const row = await this.load(i.idempotencyKey);
    if (!row) throw new Error(`payout_intent ${i.idempotencyKey} vanished after insert`);
    return row;
  }

  async load(key: string): Promise<PayoutIntent | null> {
    const row = await payoutIntent.byIdempotencyKey(kyselyFor(this.sql), key).executeTakeFirst();
    return row ? toIntent(row as IntentRow) : null;
  }

  async loadById(tenant: string, id: string): Promise<PayoutIntent | null> {
    const row = await payoutIntent
      .byIdForTenant(kyselyFor(this.sql), id, tenant)
      .executeTakeFirst();
    return row ? toIntent(row as IntentRow) : null;
  }

  async setFrom(key: string, fromAddress: string): Promise<void> {
    await payoutIntent.setBroadcasting(kyselyFor(this.sql), key, fromAddress).execute();
  }

  async markBroadcast(key: string, txId: string): Promise<void> {
    await payoutIntent.setBroadcast(kyselyFor(this.sql), key, txId).execute();
  }

  async markSettled(key: string): Promise<void> {
    await payoutIntent.setSettled(kyselyFor(this.sql), key).execute();
  }

  async markFailed(key: string, reason: string): Promise<void> {
    await payoutIntent.setFailed(kyselyFor(this.sql), key, reason.slice(0, 500)).execute();
  }

  async stuck(olderThanMs: number, now: Date = new Date()): Promise<PayoutIntent[]> {
    const cutoff = new Date(now.getTime() - olderThanMs);
    const rows = await payoutIntent.stuckSince(kyselyFor(this.sql), cutoff).execute();
    return rows.map((r) => toIntent(r as IntentRow));
  }
}
