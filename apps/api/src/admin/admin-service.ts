import { randomUUID } from "node:crypto";
import { SqlKillSwitch } from "@cixtech/chains";
import { accountTypeOf, normalBalance } from "@cixtech/ledger";
import type { SqlClient } from "@cixtech/ledger";
import { AccountType, type LedgerAccountKey } from "@cixtech/types";
import type { Engine } from "../engine.js";

export interface AuditEntry {
  actor: string;
  action: string;
  target?: string | undefined;
  params?: Record<string, unknown> | undefined;
  result: "ok" | "error";
  detail?: string | undefined;
  ip?: string | undefined;
}

const DEFAULT_LIMIT = 100;
const clampLimit = (n: number | undefined): number =>
  Math.min(Math.max(Math.trunc(n ?? DEFAULT_LIMIT), 1), 500);

export interface AssetPosition {
  asset: string;
  assets: string;
  liabilities: string;
  solvent: boolean;
}

/**
 * The read + safe-control surface behind the admin console (ADR 0015). Reads span
 * every tenant; controls are limited to operations that cannot move value outside
 * MPC + policy (kill-switch, webhook replay/cancel, tenant/key lifecycle). The
 * route layer authenticates and audits each mutation — this class does the work.
 */
export class AdminService {
  private readonly killSwitch: SqlKillSwitch;

  constructor(
    private readonly sql: SqlClient,
    private readonly engine: Engine,
    private readonly limits: {
      maxPerPayout: string;
      velocityWindowMs: number;
      velocityMax: string;
    },
  ) {
    this.killSwitch = new SqlKillSwitch(sql);
  }

  // ── Observability ─────────────────────────────────────────────────────────

  /** Solvency per asset (Σ ASSET vs Σ LIABILITY) computed from the balance table. */
  async solvency(): Promise<AssetPosition[]> {
    const { rows } = await this.sql.query<{ account: string; asset: string; amount: string }>(
      "SELECT account, asset, amount FROM balance",
    );
    const byAsset = new Map<string, { assets: bigint; liabilities: bigint }>();
    for (const r of rows) {
      const key = r.account as LedgerAccountKey;
      const type = accountTypeOf(key);
      const magnitude = normalBalance(key, BigInt(r.amount));
      const slot = byAsset.get(r.asset) ?? { assets: 0n, liabilities: 0n };
      if (type === AccountType.Asset) slot.assets += magnitude;
      else if (type === AccountType.Liability) slot.liabilities += magnitude;
      byAsset.set(r.asset, slot);
    }
    return [...byAsset.entries()]
      .map(([asset, v]) => ({
        asset,
        assets: v.assets.toString(),
        liabilities: v.liabilities.toString(),
        solvent: v.assets >= v.liabilities,
      }))
      .sort((a, b) => a.asset.localeCompare(b.asset));
  }

  async overview() {
    const [solvency, counts, kill] = await Promise.all([
      this.solvency(),
      this.counts(),
      this.killSwitch.engaged({
        tenant: "",
        merchant: "",
        chain: "",
        asset: "",
        amountBaseUnits: 0n,
        destination: "",
      }),
    ]);
    return { solvency, counts, killSwitchEngaged: kill, limits: this.limits };
  }

  private async counts() {
    const one = async (text: string): Promise<number> => {
      const { rows } = await this.sql.query<{ n: string }>(text);
      return Number(rows[0]?.n ?? "0");
    };
    const [tenants, accounts, entries, webhooksPending, webhooksDead, errors] = await Promise.all([
      one("SELECT count(*) AS n FROM tenant"),
      one("SELECT count(*) AS n FROM account"),
      one("SELECT count(*) AS n FROM journal_entry"),
      one("SELECT count(*) AS n FROM webhook_delivery WHERE status = 'pending'"),
      one("SELECT count(*) AS n FROM webhook_delivery WHERE status = 'dead'"),
      one("SELECT count(*) AS n FROM error_log WHERE at > now() - interval '24 hours'"),
    ]);
    return { tenants, accounts, entries, webhooksPending, webhooksDead, errors24h: errors };
  }

  async listTenants() {
    const { rows } = await this.sql.query(
      `SELECT t.id, t.name, t.created_at,
              (SELECT count(*) FROM account a WHERE a.tenant_id = t.id) AS accounts,
              (SELECT count(*) FROM api_key k WHERE k.tenant_id = t.id) AS api_keys
         FROM tenant t ORDER BY t.created_at DESC`,
    );
    return rows;
  }

  async getTenant(id: string) {
    const t = await this.sql.query("SELECT id, name, created_at FROM tenant WHERE id = $1", [id]);
    if (t.rows.length === 0) return null;
    const accounts = await this.sql.query(
      "SELECT id, external_ref, created_at FROM account WHERE tenant_id = $1 ORDER BY created_at DESC",
      [id],
    );
    const endpoint = await this.sql.query<{ url: string }>(
      "SELECT url FROM webhook_endpoint WHERE tenant_id = $1",
      [id],
    );
    return {
      tenant: t.rows[0],
      accounts: accounts.rows,
      webhookUrl: endpoint.rows[0]?.url ?? null, // secret is never returned
    };
  }

  async ledgerAccounts() {
    const { rows } = await this.sql.query<{ account: string; asset: string; amount: string }>(
      "SELECT account, asset, amount FROM balance ORDER BY account, asset",
    );
    return rows.map((r) => ({
      account: r.account,
      asset: r.asset,
      type: accountTypeOf(r.account as LedgerAccountKey),
      balance: normalBalance(r.account as LedgerAccountKey, BigInt(r.amount)).toString(),
    }));
  }

  /** Journal entries with their postings; filter by account and/or kind prefix. */
  async entries(opts: { account?: string; kindPrefix?: string; limit?: number } = {}) {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.kindPrefix) {
      params.push(`${opts.kindPrefix}%`);
      where.push(`je.kind LIKE $${params.length}`);
    }
    if (opts.account) {
      params.push(opts.account);
      where.push(
        `je.id IN (SELECT journal_entry_id FROM posting WHERE account = $${params.length})`,
      );
    }
    params.push(clampLimit(opts.limit));
    const { rows } = await this.sql.query<{
      id: string;
      kind: string;
      occurred_at: string;
      idempotency_key: string;
    }>(
      `SELECT id, kind, occurred_at, idempotency_key FROM journal_entry je
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY occurred_at DESC LIMIT $${params.length}`,
      params,
    );
    const ids = rows.map((r) => r.id);
    const postings = ids.length
      ? (
          await this.sql.query<{
            journal_entry_id: string;
            account: string;
            asset: string;
            amount: string;
            direction: string;
          }>(
            `SELECT journal_entry_id, account, asset, amount, direction FROM posting
             WHERE journal_entry_id = ANY($1) ORDER BY id`,
            [ids],
          )
        ).rows
      : [];
    return rows.map((e) => ({
      ...e,
      postings: postings.filter((p) => p.journal_entry_id === e.id),
    }));
  }

  listDeposits(limit?: number) {
    return this.entries({ kindPrefix: "deposit", ...(limit !== undefined ? { limit } : {}) });
  }
  listPayouts(limit?: number) {
    return this.entries({ kindPrefix: "payout", ...(limit !== undefined ? { limit } : {}) });
  }

  async listWebhooks(opts: { status?: string; limit?: number } = {}) {
    const params: unknown[] = [];
    let where = "";
    if (opts.status) {
      params.push(opts.status);
      where = "WHERE status = $1";
    }
    params.push(clampLimit(opts.limit));
    const { rows } = await this.sql.query(
      `SELECT id, tenant_id, status, attempts, next_attempt, last_error, created_at
         FROM webhook_delivery ${where} ORDER BY created_at DESC LIMIT $${params.length}`,
      params,
    );
    return rows;
  }

  async getWebhook(id: string) {
    const { rows } = await this.sql.query(
      `SELECT id, tenant_id, body, status, attempts, next_attempt, last_error, created_at
         FROM webhook_delivery WHERE id = $1`,
      [id],
    );
    return rows[0] ?? null;
  }

  async listAudit(limit?: number) {
    const { rows } = await this.sql.query(
      `SELECT id, actor, action, target, params, result, detail, ip, at
         FROM admin_audit ORDER BY at DESC LIMIT $1`,
      [clampLimit(limit)],
    );
    return rows;
  }

  async listErrors(limit?: number) {
    const { rows } = await this.sql.query(
      "SELECT id, code, message, context, at FROM error_log ORDER BY at DESC LIMIT $1",
      [clampLimit(limit)],
    );
    return rows;
  }

  // ── Safe control plane (each caller audits) ─────────────────────────────────

  async killSwitchState(): Promise<{ engaged: boolean }> {
    const engaged = await this.killSwitch.engaged({
      tenant: "",
      merchant: "",
      chain: "",
      asset: "",
      amountBaseUnits: 0n,
      destination: "",
    });
    return { engaged };
  }

  async engageKillSwitch(reason: string): Promise<void> {
    await this.killSwitch.engage(reason);
  }
  async resetKillSwitch(): Promise<void> {
    await this.killSwitch.reset();
  }

  /** Re-queue a delivery for immediate retry. Returns false if it does not exist. */
  async replayWebhook(id: string): Promise<boolean> {
    const { rows } = await this.sql.query(
      `UPDATE webhook_delivery
          SET status = 'pending', attempts = 0, next_attempt = now(), last_error = null
        WHERE id = $1 RETURNING id`,
      [id],
    );
    return rows.length > 0;
  }

  /** Dead-letter a delivery so the dispatcher stops retrying it. */
  async cancelWebhook(id: string): Promise<boolean> {
    const { rows } = await this.sql.query(
      "UPDATE webhook_delivery SET status = 'dead' WHERE id = $1 RETURNING id",
      [id],
    );
    return rows.length > 0;
  }

  /** Provision a tenant; the API key is returned ONCE (only its hash is stored). */
  createTenant(name: string): Promise<{ tenant: { id: string; name: string }; apiKey: string }> {
    return this.engine.tenants.createTenant(name);
  }

  /** Append an immutable control-plane audit row (ADR 0015). */
  async recordAudit(entry: AuditEntry): Promise<void> {
    await this.sql.query(
      `INSERT INTO admin_audit (id, actor, action, target, params, result, detail, ip)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        randomUUID(),
        entry.actor,
        entry.action,
        entry.target ?? null,
        entry.params ? JSON.stringify(entry.params) : null,
        entry.result,
        entry.detail ?? null,
        entry.ip ?? null,
      ],
    );
  }
}
