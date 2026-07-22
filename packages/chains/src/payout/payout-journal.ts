import type { SqlClient } from "@cixtech/ledger";

/**
 * Durable payout state machine (build spec §16 flow). Every payout intent is
 * recorded BEFORE it broadcasts, and its on-chain tx id is recorded before the
 * ledger settles — so a crash at any point is recoverable and, crucially, a retry
 * never broadcasts a second on-chain transfer:
 *
 *   locked → broadcasting → broadcast → settled          (failed on a terminal error)
 *
 * A retry with the same idempotency key resumes from the recorded state rather
 * than re-gathering and re-sending. Pairs with a broadcaster that is idempotent on
 * the same key: the window between "sent on chain" and "recorded broadcast" is
 * closed by the broadcaster returning the same tx id for the same key.
 */
export const PAYOUT_JOURNAL_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS payout_intent (
  idempotency_key   text PRIMARY KEY,
  tenant            text NOT NULL,
  merchant          text NOT NULL,
  chain             text NOT NULL,
  asset             text NOT NULL,
  amount_base_units numeric(78,0) NOT NULL,
  destination       text NOT NULL,
  from_address      text,
  tx_id             text,
  status            text NOT NULL DEFAULT 'locked'
                    CHECK (status IN ('locked','broadcasting','broadcast','settled','failed')),
  last_error        text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS payout_intent_recovery ON payout_intent(status, updated_at);
`;

export type PayoutIntentStatus = "locked" | "broadcasting" | "broadcast" | "settled" | "failed";

export interface PayoutIntent {
  idempotencyKey: string;
  tenant: string;
  merchant: string;
  chain: string;
  asset: string;
  amountBaseUnits: bigint;
  destination: string;
  fromAddress: string | null;
  txId: string | null;
  status: PayoutIntentStatus;
  createdAt: Date;
}

interface IntentRow {
  idempotency_key: string;
  tenant: string;
  merchant: string;
  chain: string;
  asset: string;
  amount_base_units: string;
  destination: string;
  from_address: string | null;
  tx_id: string | null;
  status: PayoutIntentStatus;
  created_at: string;
}

const toIntent = (r: IntentRow): PayoutIntent => ({
  idempotencyKey: r.idempotency_key,
  tenant: r.tenant,
  merchant: r.merchant,
  chain: r.chain,
  asset: r.asset,
  amountBaseUnits: BigInt(r.amount_base_units),
  destination: r.destination,
  fromAddress: r.from_address,
  txId: r.tx_id,
  status: r.status,
  createdAt: new Date(r.created_at),
});

export interface NewIntent {
  idempotencyKey: string;
  tenant: string;
  merchant: string;
  chain: string;
  asset: string;
  amountBaseUnits: bigint;
  destination: string;
}

export class PayoutJournal {
  constructor(private readonly sql: SqlClient) {}

  /** Record the intent if new (status `locked`); always returns the current stored row. */
  async begin(i: NewIntent): Promise<PayoutIntent> {
    await this.sql.query(
      `INSERT INTO payout_intent
         (idempotency_key, tenant, merchant, chain, asset, amount_base_units, destination)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [
        i.idempotencyKey,
        i.tenant,
        i.merchant,
        i.chain,
        i.asset,
        i.amountBaseUnits.toString(),
        i.destination,
      ],
    );
    const row = await this.load(i.idempotencyKey);
    if (!row) throw new Error(`payout_intent ${i.idempotencyKey} vanished after insert`);
    return row;
  }

  async load(key: string): Promise<PayoutIntent | null> {
    const { rows } = await this.sql.query<IntentRow>(
      "SELECT * FROM payout_intent WHERE idempotency_key = $1",
      [key],
    );
    return rows[0] ? toIntent(rows[0]) : null;
  }

  /** Record which pool address will fund the payout, before broadcasting. */
  async setFrom(key: string, fromAddress: string): Promise<void> {
    await this.sql.query(
      "UPDATE payout_intent SET from_address = $2, status = 'broadcasting', updated_at = now() WHERE idempotency_key = $1",
      [key, fromAddress],
    );
  }

  /** Record the on-chain tx id once broadcast returns; the ledger may now settle. */
  async markBroadcast(key: string, txId: string): Promise<void> {
    await this.sql.query(
      "UPDATE payout_intent SET tx_id = $2, status = 'broadcast', updated_at = now() WHERE idempotency_key = $1",
      [key, txId],
    );
  }

  async markSettled(key: string): Promise<void> {
    await this.sql.query(
      "UPDATE payout_intent SET status = 'settled', updated_at = now() WHERE idempotency_key = $1",
      [key],
    );
  }

  async markFailed(key: string, reason: string): Promise<void> {
    await this.sql.query(
      "UPDATE payout_intent SET status = 'failed', last_error = $2, updated_at = now() WHERE idempotency_key = $1",
      [key, reason.slice(0, 500)],
    );
  }

  /**
   * Intents that are mid-flight and older than `olderThanMs` — the recovery job's
   * input. `broadcast` means the tx sent but the ledger never settled; `locked`
   * or `broadcasting` means it may or may not have reached the chain and needs a
   * resume (idempotent) or an operator/external-reconciler decision.
   */
  async stuck(olderThanMs: number, now: Date = new Date()): Promise<PayoutIntent[]> {
    const cutoff = new Date(now.getTime() - olderThanMs).toISOString();
    const { rows } = await this.sql.query<IntentRow>(
      `SELECT * FROM payout_intent
        WHERE status IN ('locked','broadcasting','broadcast') AND updated_at < $1
        ORDER BY updated_at`,
      [cutoff],
    );
    return rows.map(toIntent);
  }
}
