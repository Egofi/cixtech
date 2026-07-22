import type { SqlClient } from "@cixtech/ledger";
import { normalBalance } from "@cixtech/ledger";
import type { LedgerAccountKey } from "@cixtech/types";

/**
 * Tenant-scoped reads for the portal + `/v1` activity endpoints. Every query is
 * filtered by the AUTHENTICATED tenant id — a tenant can never see another
 * tenant's rows. Reuses the admin console's query shapes (journal_entry + posting
 * batch, webhook_delivery) with a tenant predicate; payouts come from the durable
 * `payout_intent` journal, which carries tenant/status/tx_id directly.
 */
export class PortalService {
  constructor(private readonly sql: SqlClient) {}

  /** Available balances across the tenant's accounts, from the materialized balance table. */
  async balances(
    tenantId: string,
  ): Promise<Array<{ accountId: string; asset: string; available: string }>> {
    const { rows } = await this.sql.query<{ account: string; asset: string; amount: string }>(
      `SELECT account, asset, amount::text AS amount FROM balance
        WHERE account LIKE 'merchant_available:' || $1 || ':%'
        ORDER BY account, asset`,
      [tenantId],
    );
    return rows.map((r) => ({
      accountId: r.account.split(":")[2] ?? "",
      asset: r.asset,
      available: normalBalance(r.account as LedgerAccountKey, BigInt(r.amount)).toString(),
    }));
  }

  /** The account's pool deposit addresses with their lifecycle state. */
  async depositAddresses(
    tenantId: string,
    accountId: string,
  ): Promise<
    Array<{ chain: string; address: string; state: string; cooldownUntil: string | null }>
  > {
    const { rows } = await this.sql.query<{
      chain: string;
      address: string;
      state: string;
      cooldown_until: string | null;
    }>(
      `SELECT chain, address, state, cooldown_until FROM pool_address
        WHERE tenant = $1 AND merchant = $2 ORDER BY chain, derivation_index`,
      [tenantId, accountId],
    );
    return rows.map((r) => ({
      chain: r.chain,
      address: r.address,
      state: r.state,
      cooldownUntil: r.cooldown_until ? new Date(r.cooldown_until).toISOString() : null,
    }));
  }

  /**
   * Deposit history: journal entries (credits, quarantines, reversals) that touch
   * this tenant's liability accounts. Asset/amount/account are read from the
   * entry's posting against `merchant_available:{tenant}:{account}` (net credit)
   * or `compliance_suspense:{tenant}` (quarantined — accountId null).
   */
  async deposits(
    tenantId: string,
    limit = 50,
  ): Promise<
    Array<{
      id: string;
      kind: string;
      occurredAt: string;
      asset: string;
      amount: string;
      accountId: string | null;
    }>
  > {
    const { rows } = await this.sql.query<{
      id: string;
      kind: string;
      occurred_at: string;
      account: string;
      asset: string;
      amount: string;
    }>(
      `SELECT je.id, je.kind, je.occurred_at, p.account, p.asset, p.amount::text AS amount
         FROM journal_entry je
         JOIN posting p ON p.journal_entry_id = je.id
        WHERE (je.kind LIKE 'deposit%' OR je.kind LIKE 'reverse%')
          AND (p.account LIKE 'merchant_available:' || $1 || ':%'
               OR p.account LIKE 'compliance_suspense:' || $1 || '%')
        ORDER BY je.occurred_at DESC LIMIT $2`,
      [tenantId, limit],
    );
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      occurredAt: new Date(r.occurred_at).toISOString(),
      asset: r.asset,
      amount: r.amount,
      accountId: r.account.startsWith("merchant_available:")
        ? (r.account.split(":")[2] ?? null)
        : null,
    }));
  }

  /** Payout history from the durable intent journal — live status, tx id, destination. */
  async payouts(
    tenantId: string,
    limit = 50,
  ): Promise<
    Array<{
      idempotencyKey: string;
      accountId: string;
      chain: string;
      asset: string;
      amount: string;
      destination: string;
      status: string;
      txId: string | null;
      createdAt: string;
    }>
  > {
    const { rows } = await this.sql.query<{
      idempotency_key: string;
      merchant: string;
      chain: string;
      asset: string;
      amount_base_units: string;
      destination: string;
      status: string;
      tx_id: string | null;
      created_at: string;
    }>(
      `SELECT idempotency_key, merchant, chain, asset, amount_base_units::text AS amount_base_units,
              destination, status, tx_id, created_at
         FROM payout_intent WHERE tenant = $1
        ORDER BY created_at DESC LIMIT $2`,
      [tenantId, limit],
    );
    return rows.map((r) => ({
      idempotencyKey: r.idempotency_key,
      accountId: r.merchant,
      chain: r.chain,
      asset: r.asset,
      amount: r.amount_base_units,
      destination: r.destination,
      status: r.status,
      txId: r.tx_id,
      createdAt: new Date(r.created_at).toISOString(),
    }));
  }

  /** The tenant's configured webhook endpoint URL — never the secret. */
  async webhookEndpoint(tenantId: string): Promise<{ url: string | null }> {
    const { rows } = await this.sql.query<{ url: string }>(
      "SELECT url FROM webhook_endpoint WHERE tenant_id = $1",
      [tenantId],
    );
    return { url: rows[0]?.url ?? null };
  }

  /** Webhook delivery history, newest first; `event` parsed from the stored signed body. */
  async webhookDeliveries(
    tenantId: string,
    limit = 50,
  ): Promise<
    Array<{
      id: string;
      event: string;
      status: string;
      attempts: number;
      lastError: string | null;
      createdAt: string;
    }>
  > {
    const { rows } = await this.sql.query<{
      id: string;
      body: string;
      status: string;
      attempts: number;
      last_error: string | null;
      created_at: string;
    }>(
      `SELECT id, body, status, attempts, last_error, created_at FROM webhook_delivery
        WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [tenantId, limit],
    );
    return rows.map((r) => {
      let event = "unknown";
      try {
        event = (JSON.parse(r.body) as { event?: string }).event ?? "unknown";
      } catch {
        // a malformed body still lists — the delivery record matters more than the parse
      }
      return {
        id: r.id,
        event,
        status: r.status,
        attempts: Number(r.attempts),
        lastError: r.last_error,
        createdAt: new Date(r.created_at).toISOString(),
      };
    });
  }
}
