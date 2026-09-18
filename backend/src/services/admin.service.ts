import { randomBytes, randomUUID } from "node:crypto";
import { assetRegistry } from "@/chain-config";
import { kyselyFor } from "@/postgres";
import {
  adminAudit,
  adminBalances,
  adminEarnings,
  adminErrors,
  adminLedger,
  adminOverview,
  adminPool,
  adminTenants,
  adminWebhooks,
  poolAddress,
} from "@/queries";
import { FeeSweepService, LedgerService } from "@/services";
import { AuthStore, SqlKillSwitch, SqlLedgerStore, TenantStore } from "@/stores";

import { FeeTreasuryNotConfiguredError } from "@/common";
import { accountTypeOf, feeSwept, normalBalance } from "@/ledger";

import type { Engine } from "@/api/engine.js";
import {
  AccountType,
  Asset,
  type AssetPosition,
  type AuditEntry,
  type Db,
  IdempotencyKey,
  type JournalEntryId,
  type LedgerAccountKey,
  SCOPES,
  type Scope,
  type SqlClient,
} from "@/types";

/**
 * The first person on a tenant gets `admin`: they have to be able to invite the
 * rest of their people, and `member` deliberately cannot approve (ADR 0018).
 */
const TENANT_OWNER_ROLE = "admin";

const DEFAULT_LIMIT = 100;
const clampLimit = (n: number | undefined): number =>
  Math.min(Math.max(Math.trunc(n ?? DEFAULT_LIMIT), 1), 500);

export class AdminService {
  private readonly db: Db;

  private readonly killSwitch: SqlKillSwitch;

  constructor(
    private readonly sql: SqlClient,
    private readonly engine: Engine,
    private readonly limits: {
      maxPerPayout: string;
      velocityWindowMs: number;
      velocityMax: string;
    },

    private readonly feeTreasuryAddressFor?: (chain: string) => string | undefined,
  ) {
    this.killSwitch = new SqlKillSwitch(sql);
    this.db = kyselyFor(sql);
  }

  async solvency(): Promise<AssetPosition[]> {
    const rows = await adminBalances.all(this.db).execute();
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

    return {
      solvency,
      counts,
      killSwitchEngaged: kill,
      limits: this.limits,
      assets: assetRegistry(),
    };
  }

  private async counts() {
    const one = async (q: { executeTakeFirst: () => Promise<{ n: string } | undefined> }) =>
      Number((await q.executeTakeFirst())?.n ?? "0");
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [tenants, accounts, entries, webhooksPending, webhooksDead, errors] = await Promise.all([
      one(adminOverview.tenants(this.db)),
      one(adminOverview.accounts(this.db)),
      one(adminOverview.entries(this.db)),
      one(adminOverview.webhooksWithStatus(this.db, "pending")),
      one(adminOverview.webhooksWithStatus(this.db, "dead")),
      one(adminOverview.errorsSince(this.db, dayAgo)),
    ]);
    return { tenants, accounts, entries, webhooksPending, webhooksDead, errors24h: errors };
  }

  async listTenants() {
    return adminTenants.list(this.db).execute();
  }

  async getTenant(id: string) {
    const tenantRow = await adminTenants.byId(this.db, id).executeTakeFirst();
    if (!tenantRow) return null;
    const accountRows = await adminTenants.accountsFor(this.db, id).execute();
    const endpointRow = await adminWebhooks.endpointFor(this.db, id).executeTakeFirst();
    return {
      tenant: tenantRow,
      accounts: accountRows,
      webhookUrl: endpointRow?.url ?? null,
    };
  }

  async ledgerAccounts() {
    const rows = await adminBalances.allOrdered(this.db).execute();
    return rows.map((r) => ({
      account: r.account,
      asset: r.asset,
      type: accountTypeOf(r.account as LedgerAccountKey),
      balance: normalBalance(r.account as LedgerAccountKey, BigInt(r.amount)).toString(),
    }));
  }

  async earningsAnalysis() {
    const balances = await adminBalances.all(this.db).execute();

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
        slot.unsweptFee += mag;
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

    const tenantFees = await adminBalances.feeRevenue(this.db).execute();

    const tenants = await adminTenants.all(this.db).execute();
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

    const { rows: trendRows } = await adminEarnings.feeTrends(this.db);

    return {
      summary: assetsSummary,
      tenantBreakdown,
      trends: trendRows,
    };
  }

  async poolAddresses(
    filter: {
      chain?: string | undefined;
      tenant?: string | undefined;
      merchant?: string | undefined;
      state?: string | undefined;
      fundedOnly?: boolean | undefined;
      asset?: string | undefined;
      limit?: number | undefined;
      offset?: number | undefined;
    } = {},
  ) {
    const asset = (filter.asset ?? "USDT").toUpperCase();
    const limit = clampLimit(filter.limit);
    const offset = Math.max(0, Math.trunc(filter.offset ?? 0));

    const where: string[] = [];
    const params: unknown[] = [asset];
    const add = (clause: string, value: unknown): void => {
      params.push(value);
      where.push(`${clause} $${params.length}`);
    };
    if (filter.chain) add("p.chain =", filter.chain.toUpperCase());
    if (filter.tenant) add("p.tenant =", filter.tenant);
    if (filter.merchant) add("p.merchant =", filter.merchant);
    if (filter.state) add("p.state =", filter.state.toUpperCase());
    if (filter.fundedOnly) where.push("COALESCE(b.balance_base_units, 0) > 0");
    const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

    const rows = await adminPool
      .addressesWithBalance(this.db, asset, filter, limit, offset)
      .execute();

    const ledgerRows = await adminBalances.poolAddrForAsset(this.db, asset).execute();
    const ledgerByGroup = new Map<string, bigint>();
    for (const r of ledgerRows) {
      const key = r.account as LedgerAccountKey;
      ledgerByGroup.set(r.account.replace(/^pool_addr:/, ""), normalBalance(key, BigInt(r.amount)));
    }

    const { rows: groupRows } = await adminPool.groupTotals(this.db, asset);

    const groups = groupRows.map((g) => {
      const ledger = ledgerByGroup.get(`${g.chain}:${g.merchant}`) ?? 0n;
      const onChain = BigInt(g.onchain);
      return {
        chain: g.chain,
        merchant: g.merchant,
        ledgerBaseUnits: ledger.toString(),
        onChainBaseUnits: onChain.toString(),
        driftBaseUnits: (onChain - ledger).toString(),
        addresses: Number(g.addresses),

        fullyObserved: Number(g.observed) === Number(g.addresses),
        oldestObservation: g.oldest ? new Date(g.oldest).toISOString() : null,
      };
    });

    const driftByGroup = new Map(groups.map((g) => [`${g.chain}:${g.merchant}`, g]));

    return {
      asset,
      total: Number(rows[0]?.total ?? "0"),
      limit,
      offset,
      addresses: rows.map((r) => ({
        address: r.address,
        tenant: r.tenant,
        merchant: r.merchant,
        chain: r.chain,
        derivationIndex: r.derivation_index,
        state: r.state,
        gatherStrategy: r.gather_strategy,
        cooldownUntil: r.cooldown_until ? new Date(r.cooldown_until).toISOString() : null,
        balanceBaseUnits: r.balance ?? null,
        observedAt: r.observed_at ? new Date(r.observed_at).toISOString() : null,
        lastError: r.last_error,
        groupDriftBaseUnits: driftByGroup.get(`${r.chain}:${r.merchant}`)?.driftBaseUnits ?? "0",
      })),
      groups,
    };
  }

  async sweepFees(asset = "USDT") {
    if (!this.feeTreasuryAddressFor) {
      throw new FeeTreasuryNotConfiguredError(
        "No fee treasury address configured — set CIXTECH_FEE_TREASURY_ADDRESS_<CHAIN> before collecting fees.",
        { exposable: true },
      );
    }
    const service = new FeeSweepService(
      this.sql,
      this.engine.ledger,
      this.engine.feeSweepPlanner,

      this.engine.broadcaster,
      {
        treasuryAddressFor: this.feeTreasuryAddressFor,

        ...(this.engine.authorizer ? { authorizer: this.engine.authorizer } : {}),
        // Without this the sweep skips GatherStrategy.prepare, so an ERC-20
        // sweep leg is broadcast from a pool address holding no native gas.
        ...(this.engine.gatherStrategies ? { gatherStrategies: this.engine.gatherStrategies } : {}),
        killSwitch: this.killSwitch,

        gatherLease: this.engine.gatherLease,
      },
    );
    return service.sweep(asset);
  }

  async verifyOnchainWallet(chain: string, target: string, asset = "USDT") {
    const cleanChain = chain.toUpperCase();

    let cleanTarget = target.trim();
    if (cleanTarget.includes(":")) {
      const parts = cleanTarget.split(":");
      cleanTarget = parts[parts.length - 1] ?? cleanTarget;
    }

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

      const poolRows = await poolAddress.addressesFor(this.db, merchantId, cleanChain).execute();
      targetAddresses = poolRows.map((r) => r.address);
    }

    const poolKey = merchantId
      ? `pool_addr:${cleanChain}:${merchantId}`
      : `pool_addr:${cleanChain}:${cleanTarget}`;
    const balRow = await adminBalances
      .forAccountOrSuffix(this.db, poolKey, cleanTarget, asset)
      .executeTakeFirst();

    const ledgerBalance = balRow?.amount ?? "0";
    const ledgerBig = BigInt(ledgerBalance);

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

    const explorerMap: Record<string, string> = {
      TRON: `https://nile.tronscan.org/#/address/${primaryAddress}`,
      BASE: `https://basescan.org/address/${primaryAddress}`,
      ARBITRUM: `https://arbiscan.io/address/${primaryAddress}`,
      POLYGON: `https://polygonscan.com/address/${primaryAddress}`,
      BSC: `https://bscscan.com/address/${primaryAddress}`,
      ETHEREUM: `https://etherscan.io/address/${primaryAddress}`,
    };
    const explorerUrl =
      explorerMap[cleanChain] ?? `https://blockscan.com/address/${primaryAddress}`;

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
    const rows = await adminLedger.entries(this.db, opts, clampLimit(opts.limit)).execute();
    const ids = rows.map((r) => r.id);
    const postings = ids.length ? await adminLedger.postingsForEntries(this.db, ids).execute() : [];
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
    return adminWebhooks.list(this.db, opts.status, clampLimit(opts.limit)).execute();
  }

  async getWebhook(id: string) {
    return (await adminWebhooks.byId(this.db, id).executeTakeFirst()) ?? null;
  }

  async listAudit(limit?: number) {
    return adminAudit.list(this.db, clampLimit(limit)).execute();
  }

  async listErrors(limit?: number) {
    return adminErrors.list(this.db, clampLimit(limit)).execute();
  }

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

  async replayWebhook(id: string): Promise<boolean> {
    const rows = await adminWebhooks.replay(this.db, id).execute();
    return rows.length > 0;
  }

  async cancelWebhook(id: string): Promise<boolean> {
    const rows = await adminWebhooks.kill(this.db, id).execute();
    return rows.length > 0;
  }

  /**
   * Provision a tenant: the tenant row, a machine credential, and — when an
   * owner email is given — the tenant's first human sign-in.
   *
   * Both credentials exist because they are not interchangeable (ADR 0018). The
   * `cxk_…` key is for the tenant's backend calling `/v1`; the portal
   * authenticates a *person* against a `principal`, so a tenant created without
   * one has no way for anyone to sign in and was reachable only by API.
   *
   * The first user is a tenant `admin`: it can move funds, approve, and invite
   * the rest of their people. The password is generated rather than accepted
   * from the caller, so it never travels in a request body or an audit param,
   * and `mustChangePassword` makes it a handover rather than a credential.
   *
   * One transaction, because a duplicate email is a normal thing to hit and the
   * failure mode otherwise is an orphan tenant with a live API key and nobody
   * able to sign in.
   */
  async createTenant(
    name: string,
    scopes?: readonly Scope[],
    owner?: { email: string } | undefined,
  ): Promise<{
    tenant: { id: string; name: string };
    apiKey: string;
    owner: { email: string; role: string; password: string } | null;
  }> {
    return this.sql.transaction(async (tx) => {
      const created = await new TenantStore(tx).createTenant(name, scopes ?? SCOPES);
      if (!owner) return { ...created, owner: null };

      const password = randomBytes(18).toString("base64url");
      const principal = await new AuthStore(tx).createPrincipal({
        kind: "tenant_user",
        tenantId: created.tenant.id,
        email: owner.email,
        password,
        role: TENANT_OWNER_ROLE,
        mustChangePassword: true,
      });
      return {
        ...created,
        owner: { email: principal.email, role: principal.role, password },
      };
    });
  }

  issueKey(tenantId: string, scopes?: readonly Scope[], label?: string): Promise<string> {
    return this.engine.tenants.issueKey(tenantId, scopes ?? SCOPES, label);
  }

  assets() {
    return assetRegistry();
  }

  listKeys(tenantId: string) {
    return this.engine.tenants.listKeys(tenantId);
  }

  rotateKeys(tenantId: string, reason?: string, scopes?: readonly Scope[]) {
    return this.engine.tenants.rotateKeys(tenantId, {
      ...(reason ? { reason } : {}),
      ...(scopes ? { scopes } : {}),
    });
  }

  revokeKey(tenantId: string, keyId: string, reason?: string) {
    return this.engine.tenants.revokeKey(tenantId, keyId, reason);
  }

  async recordAudit(entry: AuditEntry): Promise<void> {
    await adminAudit
      .insert(this.db, {
        id: randomUUID(),
        actor: entry.actor,
        action: entry.action,
        target: entry.target ?? null,
        params: entry.params ? JSON.stringify(entry.params) : null,
        result: entry.result,
        detail: entry.detail ?? null,
        ip: entry.ip ?? null,
      })
      .execute();
  }
}
