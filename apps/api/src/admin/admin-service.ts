import { randomUUID } from "node:crypto";
import { assetRegistry } from "@cixtech/chain-config";
import { FeeSweepService, SqlKillSwitch } from "@cixtech/chains";
import { accountTypeOf, feeSwept, LedgerService, normalBalance, SqlLedgerStore } from "@cixtech/ledger";
import type { SqlClient } from "@cixtech/ledger";
import { AccountType, Asset, IdempotencyKey, type JournalEntryId, LedgerAccountKey } from "@cixtech/types";
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
    // `assets` carries decimals so the console can render base units as money.
    // Without it every figure here is off by 10^decimals (§16.5 keeps the table
    // in chain-config, so the console is told rather than guessing).
    return {
      solvency,
      counts,
      killSwitchEngaged: kill,
      limits: this.limits,
      assets: assetRegistry(),
    };
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
              (SELECT count(*) FROM api_key k
                WHERE k.tenant_id = t.id AND k.revoked_at IS NULL) AS api_keys
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

  /**
   * Platform earnings analysis: fee revenue, network gas costs, net margins,
   * tenant breakdown, and recent revenue trends across 24h / 7d / 30d.
   */
  async earningsAnalysis() {
    const { rows: balances } = await this.sql.query<{
      account: string;
      asset: string;
      amount: string;
    }>("SELECT account, asset, amount FROM balance");

    // Aggregate by asset: platform fee revenue vs network gas expense
    const byAsset = new Map<
      string,
      { feeRevenue: bigint; gasExpense: bigint; unsweptFee: bigint }
    >();

    for (const r of balances) {
      const key = r.account as LedgerAccountKey;
      const type = accountTypeOf(key);
      const mag = normalBalance(key, BigInt(r.amount));
      const slot = byAsset.get(r.asset) ?? { feeRevenue: 0n, gasExpense: 0n, unsweptFee: 0n };

      if (r.account.startsWith("egofi_fee_revenue:")) {
        slot.feeRevenue += mag;
        slot.unsweptFee += mag; // Accrued fee revenue sitting across pool/merchant accounts
      } else if (r.account.startsWith("treasury:")) {
        slot.unsweptFee -= mag;
      } else if (r.account.endsWith("_expense")) {
        slot.gasExpense += mag;
      }
      byAsset.set(r.asset, slot);
    }

    const assetsSummary = [...byAsset.entries()]
      .map(([asset, v]) => {
        const netMargin = v.feeRevenue - v.gasExpense;
        const unswept = v.unsweptFee < 0n ? 0n : v.unsweptFee;
        return {
          asset,
          feeRevenue: v.feeRevenue.toString(),
          gasExpense: v.gasExpense.toString(),
          netMargin: netMargin.toString(),
          unsweptFee: unswept.toString(),
        };
      })
      .sort((a, b) => a.asset.localeCompare(b.asset));

    // Breakdown per tenant
    const { rows: tenantFees } = await this.sql.query<{
      account: string;
      asset: string;
      amount: string;
    }>("SELECT account, asset, amount FROM balance WHERE account LIKE 'egofi_fee_revenue:%'");

    const { rows: tenants } = await this.sql.query<{ id: string; name: string }>(
      "SELECT id, name FROM tenant",
    );
    const tenantNameMap = new Map(tenants.map((t) => [t.id, t.name]));

    const tenantBreakdown = tenantFees.map((r) => {
      const tenantId = r.account.split(":")[1] ?? "";
      const mag = normalBalance(r.account as LedgerAccountKey, BigInt(r.amount));
      return {
        tenantId,
        tenantName: tenantNameMap.get(tenantId) ?? "Unknown Tenant",
        asset: r.asset,
        feeRevenue: mag.toString(),
      };
    });

    // Recent revenue trends: 24h, 7d, 30d
    const { rows: trendRows } = await this.sql.query<{
      asset: string;
      fee24h: string;
      fee7d: string;
      fee30d: string;
    }>(
      `SELECT p.asset,
              COALESCE(SUM(CASE WHEN je.occurred_at >= now() - interval '24 hours' THEN p.amount ELSE 0 END), 0)::text AS fee24h,
              COALESCE(SUM(CASE WHEN je.occurred_at >= now() - interval '7 days' THEN p.amount ELSE 0 END), 0)::text AS fee7d,
              COALESCE(SUM(CASE WHEN je.occurred_at >= now() - interval '30 days' THEN p.amount ELSE 0 END), 0)::text AS fee30d
         FROM posting p
         JOIN journal_entry je ON p.journal_entry_id = je.id
        WHERE p.account LIKE 'egofi_fee_revenue:%' AND p.direction = 'CREDIT'
        GROUP BY p.asset`,
    );

    return {
      summary: assetsSummary,
      tenantBreakdown,
      trends: trendRows,
    };
  }

  /**
   * Sweep accrued platform fee revenue from deposit pool addresses into platform treasury.
   */
  async sweepFees(asset = "USDT") {
    const service = new FeeSweepService(this.sql);
    return service.sweep(asset);
  }

  /**
   * One-click live on-chain balance verification for any wallet address or merchant pool:
   * Compares internal double-entry ledger balance against live RPC on-chain balance.
   */
  async verifyOnchainWallet(chain: string, target: string, asset = "USDT") {
    const cleanChain = chain.toUpperCase();

    // Clean target (e.g. pool_addr:TRON:merchantId -> merchantId)
    let cleanTarget = target.trim();
    if (cleanTarget.includes(":")) {
      const parts = cleanTarget.split(":");
      cleanTarget = parts[parts.length - 1] ?? cleanTarget;
    }

    // Determine if cleanTarget is an on-chain address or a merchant/tenant ID
    const isDirectTron =
      cleanChain === "TRON" && cleanTarget.startsWith("T") && cleanTarget.length >= 33;
    const isDirectEvm = cleanTarget.startsWith("0x") && cleanTarget.length === 42;
    const isDirectAddress = isDirectTron || isDirectEvm;

    let targetAddresses: string[] = [];
    let merchantId: string | null = null;

    if (isDirectAddress) {
      targetAddresses = [cleanTarget];
    } else {
      merchantId = cleanTarget;
      // Resolve assigned blockchain addresses for this merchant/tenant from pool_address table
      const { rows: poolRows } = await this.sql.query<{ address: string }>(
        "SELECT address FROM pool_address WHERE (merchant = $1 OR tenant = $1) AND chain = $2",
        [merchantId, cleanChain],
      );
      targetAddresses = poolRows.map((r) => r.address);
    }

    // 1. Query ledger balance for the merchant or direct address
    const poolKey = merchantId
      ? `pool_addr:${cleanChain}:${merchantId}`
      : `pool_addr:${cleanChain}:${cleanTarget}`;
    const { rows: balRows } = await this.sql.query<{ amount: string }>(
      "SELECT amount FROM balance WHERE (account = $1 OR account LIKE '%' || $2) AND asset = $3",
      [poolKey, cleanTarget, asset],
    );

    const ledgerBalance = balRows[0]?.amount ?? "0";
    const ledgerBig = BigInt(ledgerBalance);

    // 2. Fetch live on-chain balance(s) using chain router
    let totalOnchainBig = 0n;
    let error: string | null = null;

    if (targetAddresses.length === 0) {
      error = isDirectAddress
        ? null
        : `No deposit addresses provisioned in pool for merchant ${cleanTarget} on ${cleanChain}.`;
    } else {
      try {
        const balanceProvider = this.engine.chains.get(cleanChain).balances;
        for (const addr of targetAddresses) {
          const b = await balanceProvider.balance(cleanChain, addr, asset);
          totalOnchainBig += b;
        }
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }
    }

    const deltaBig = totalOnchainBig - ledgerBig;

    let status: "EXACT_MATCH" | "SURPLUS" | "DEFICIT" | "UNAVAILABLE" = "EXACT_MATCH";
    if (error) {
      status = "UNAVAILABLE";
    } else if (deltaBig > 0n) {
      status = "SURPLUS";
    } else if (deltaBig < 0n) {
      status = "DEFICIT";
    }

    const primaryAddress = targetAddresses[0] || cleanTarget;

    // 3. Explorer URL mapping
    const explorerMap: Record<string, string> = {
      TRON: `https://nile.tronscan.org/#/address/${primaryAddress}`,
      BASE: `https://basescan.org/address/${primaryAddress}`,
      ARBITRUM: `https://arbiscan.io/address/${primaryAddress}`,
      POLYGON: `https://polygonscan.com/address/${primaryAddress}`,
      BSC: `https://bscscan.com/address/${primaryAddress}`,
      ETHEREUM: `https://etherscan.io/address/${primaryAddress}`,
    };
    const explorerUrl = explorerMap[cleanChain] ?? `https://blockscan.com/address/${primaryAddress}`;

    return {
      chain: cleanChain,
      address: primaryAddress,
      targetAddresses,
      merchantId,
      asset,
      ledgerBalance,
      onchainBalance: totalOnchainBig.toString(),
      delta: deltaBig.toString(),
      status,
      explorerUrl,
      error,
    };
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

  /** Issue an additional API key for a tenant (lost-key recovery); returned ONCE. */
  issueKey(tenantId: string): Promise<string> {
    return this.engine.tenants.issueKey(tenantId);
  }

  /** Symbol → decimals, so a display layer never renders base units as money. */
  assets() {
    return assetRegistry();
  }

  /** A tenant's credentials — identity and status only; keys themselves are unrecoverable. */
  listKeys(tenantId: string) {
    return this.engine.tenants.listKeys(tenantId);
  }

  /** Replace every live credential with one new key, atomically. Returned ONCE. */
  rotateKeys(tenantId: string, reason?: string) {
    return this.engine.tenants.rotateKeys(tenantId, ...(reason ? [{ reason }] : []));
  }

  /** Revoke a single credential by id. False when already revoked or unknown. */
  revokeKey(tenantId: string, keyId: string, reason?: string) {
    return this.engine.tenants.revokeKey(tenantId, keyId, reason);
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
