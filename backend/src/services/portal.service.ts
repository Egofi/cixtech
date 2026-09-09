import { normalBalance } from "@/ledger";
import { kyselyFor } from "@/postgres";
import {
  balance,
  journalEntry,
  payoutIntent,
  poolAddress,
  posting,
  webhookDelivery,
  webhookEndpoint,
} from "@/queries";
import type { Db, LedgerAccountKey, SqlClient } from "@/types";

export function coarsenDeliveryError(raw: string | null): string | null {
  if (!raw) return null;
  if (/UNSAFE_WEBHOOK_URL|private address|does not resolve/i.test(raw)) {
    return "Endpoint rejected: the URL must be a public https address";
  }
  if (/redirect/i.test(raw)) return "Endpoint redirected; webhook targets must not redirect";
  if (/timeout|aborted|ETIMEDOUT/i.test(raw)) return "Timed out waiting for your endpoint";
  const status = /endpoint returned (\d{3})/i.exec(raw);
  if (status) return `Endpoint returned HTTP ${status[1]}`;
  if (/no webhook endpoint/i.test(raw)) return "No webhook endpoint configured";
  return "Delivery failed";
}

export class PortalService {
  private readonly db: Db;

  constructor(sql: SqlClient) {
    this.db = kyselyFor(sql);
  }

  async balances(
    tenantId: string,
  ): Promise<Array<{ accountId: string; asset: string; available: string }>> {
    const rows = await balance.forTenantMerchants(this.db, tenantId).execute();
    return rows.map((r) => ({
      accountId: r.account.split(":")[2] ?? "",
      asset: r.asset,
      available: normalBalance(r.account as LedgerAccountKey, BigInt(r.amount)).toString(),
    }));
  }

  async depositAddresses(
    tenantId: string,
    accountId: string,
  ): Promise<
    Array<{ chain: string; address: string; state: string; cooldownUntil: string | null }>
  > {
    const rows = await poolAddress.forTenantMerchant(this.db, tenantId, accountId).execute();
    return rows.map((r) => ({
      chain: r.chain,
      address: r.address,
      state: r.state,
      cooldownUntil: r.cooldown_until ? new Date(r.cooldown_until).toISOString() : null,
    }));
  }

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
      grossAmount: string;
      feeCollected: string;
      feeBps: number;
      feePercent: string;
      netCredited: string;
      accountId: string | null;
    }>
  > {
    const entries = await journalEntry.depositsForTenant(this.db, tenantId, limit).execute();

    if (entries.length === 0) return [];

    const ids = entries.map((e) => e.id);
    const postings = await posting.forEntries(this.db, ids).execute();

    const postingsByEntry = new Map<string, typeof postings>();
    for (const p of postings) {
      const list = postingsByEntry.get(p.journal_entry_id) ?? [];
      list.push(p);
      postingsByEntry.set(p.journal_entry_id, list);
    }

    return entries.map((je) => {
      const list = postingsByEntry.get(je.id) ?? [];
      let asset = "";
      let accountId: string | null = null;
      let grossAmountBig = 0n;
      let feeCollectedBig = 0n;
      let netCreditedBig = 0n;

      for (const p of list) {
        if (!asset) asset = p.asset;
        const amt = BigInt(p.amount);

        if (p.account.startsWith("merchant_available:")) {
          accountId = p.account.split(":")[2] ?? null;
          netCreditedBig = amt;
        } else if (p.account.startsWith("egofi_fee_revenue:")) {
          feeCollectedBig = amt;
        } else if (p.account.startsWith("pool_addr:")) {
          grossAmountBig = amt;
        } else if (p.account.startsWith("compliance_suspense:")) {
          if (grossAmountBig === 0n) grossAmountBig = amt;
        }
      }

      if (grossAmountBig === 0n) {
        grossAmountBig = netCreditedBig + feeCollectedBig;
      }

      let feeBps = 0;
      let feePercent = "0%";
      if (grossAmountBig > 0n && feeCollectedBig > 0n) {
        feeBps = Math.round(Number((feeCollectedBig * 10000n) / grossAmountBig));
        const pct = (Number(feeCollectedBig) / Number(grossAmountBig)) * 100;
        feePercent = `${Number.parseFloat(pct.toFixed(4))}%`;
      }

      const grossStr = grossAmountBig.toString();
      const feeStr = feeCollectedBig.toString();
      const netStr = netCreditedBig.toString();

      return {
        id: je.id,
        kind: je.kind,
        occurredAt: new Date(je.occurred_at).toISOString(),
        asset,
        amount: je.kind === "deposit.quarantined" ? grossStr : netStr,
        grossAmount: grossStr,
        feeCollected: feeStr,
        feeBps,
        feePercent,
        netCredited: netStr,
        accountId,
      };
    });
  }

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
    const rows = await payoutIntent.recentFor(this.db, tenantId, limit).execute();
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

  async webhookEndpoint(tenantId: string): Promise<{ url: string | null }> {
    const row = await webhookEndpoint.urlFor(this.db, tenantId).executeTakeFirst();
    return { url: row?.url ?? null };
  }

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
    const rows = await webhookDelivery.recentFor(this.db, tenantId, limit).execute();
    return rows.map((r) => {
      let event = "unknown";
      try {
        event = (JSON.parse(r.body) as { event?: string }).event ?? "unknown";
      } catch {}
      return {
        id: r.id,
        event,
        status: r.status,
        attempts: Number(r.attempts),
        lastError: coarsenDeliveryError(r.last_error),
        createdAt: new Date(r.created_at).toISOString(),
      };
    });
  }
}
