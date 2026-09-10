import type { Db } from "@/types";
import { sql } from "kysely";

const countOf = sql<string>`count(*)`.as("n");

export const adminOverview = {
  tenants: (db: Db) => db.selectFrom("tenant").select(countOf),
  accounts: (db: Db) => db.selectFrom("account").select(countOf),
  entries: (db: Db) => db.selectFrom("journal_entry").select(countOf),
  webhooksWithStatus: (db: Db, status: string) =>
    db.selectFrom("webhook_delivery").select(countOf).where("status", "=", status),
  errorsSince: (db: Db, since: Date) =>
    db.selectFrom("error_log").select(countOf).where("at", ">", since),
};

export const adminTenants = {
  /** Tenants with their account and live-key counts — the control-plane listing. */
  list: (db: Db) =>
    db
      .selectFrom("tenant as t")
      .select((eb) => [
        "t.id",
        "t.name",
        "t.created_at",
        eb
          .selectFrom("account as a")
          .select(sql<string>`count(*)`.as("c"))
          .whereRef("a.tenant_id", "=", "t.id")
          .as("accounts"),
        eb
          .selectFrom("api_key as k")
          .select(sql<string>`count(*)`.as("c"))
          .whereRef("k.tenant_id", "=", "t.id")
          .where("k.revoked_at", "is", null)
          .as("api_keys"),
      ])
      .orderBy("t.created_at", "desc"),

  byId: (db: Db, id: string) =>
    db.selectFrom("tenant").select(["id", "name", "created_at"]).where("id", "=", id),

  accountsFor: (db: Db, tenantId: string) =>
    db
      .selectFrom("account")
      .select(["id", "external_ref", "created_at"])
      .where("tenant_id", "=", tenantId)
      .orderBy("created_at", "desc"),

  all: (db: Db) => db.selectFrom("tenant").select(["id", "name"]),
};

export const adminBalances = {
  all: (db: Db) => db.selectFrom("balance").select(["account", "asset", "amount"]),

  allOrdered: (db: Db) =>
    db
      .selectFrom("balance")
      .select(["account", "asset", "amount"])
      .orderBy("account")
      .orderBy("asset"),

  feeRevenue: (db: Db) =>
    db
      .selectFrom("balance")
      .select(["account", "asset", "amount"])
      .where("account", "like", "egofi_fee_revenue:%"),

  poolAddrForAsset: (db: Db, asset: string) =>
    db
      .selectFrom("balance")
      .select(["account", "amount"])
      .where("account", "like", "pool_addr:%")
      .where("asset", "=", asset),

  forAccountOrSuffix: (db: Db, account: string, suffix: string, asset: string) =>
    db
      .selectFrom("balance")
      .select("amount")
      .where((eb) =>
        eb.or([eb("account", "=", account), eb("account", "like", sql<string>`'%' || ${suffix}`)]),
      )
      .where("asset", "=", asset),
};

export const adminEarnings = {
  /**
   * Fee revenue bucketed by age. The CASE-per-window aggregate is the report, so
   * it stays written out rather than assembled.
   */
  feeTrends: (db: Db) =>
    sql<{ asset: string; fee24h: string; fee7d: string; fee30d: string }>`
      SELECT p.asset,
             COALESCE(SUM(CASE WHEN je.occurred_at >= now() - interval '24 hours' THEN p.amount ELSE 0 END), 0)::text AS fee24h,
             COALESCE(SUM(CASE WHEN je.occurred_at >= now() - interval '7 days'  THEN p.amount ELSE 0 END), 0)::text AS fee7d,
             COALESCE(SUM(CASE WHEN je.occurred_at >= now() - interval '30 days' THEN p.amount ELSE 0 END), 0)::text AS fee30d
        FROM posting p
        JOIN journal_entry je ON p.journal_entry_id = je.id
       WHERE p.account LIKE 'egofi_fee_revenue:%' AND p.direction = 'CREDIT'
       GROUP BY p.asset
    `.execute(db),
};

export interface PoolAddressFilter {
  chain?: string | undefined;
  tenant?: string | undefined;
  merchant?: string | undefined;
  state?: string | undefined;
  fundedOnly?: boolean | undefined;
}

export const adminPool = {
  /**
   * The pool-address table with its observed on-chain balance. The filters used to
   * be concatenated into the SQL with hand-counted `$n` placeholders; `$if` binds
   * them instead, so adding a filter cannot shift another one's parameter index.
   */
  addressesWithBalance: (
    db: Db,
    asset: string,
    filter: PoolAddressFilter,
    limit: number,
    offset: number,
  ) =>
    db
      .selectFrom("pool_address as p")
      .leftJoin("pool_address_balance as b", (join) =>
        join
          .onRef("b.chain", "=", "p.chain")
          .onRef("b.address", "=", "p.address")
          .on("b.asset", "=", asset),
      )
      .select([
        "p.address",
        "p.tenant",
        "p.merchant",
        "p.chain",
        "p.derivation_index",
        "p.state",
        "p.gather_strategy",
        "p.cooldown_until",
        sql<string | null>`b.balance_base_units::text`.as("balance"),
        "b.observed_at",
        "b.last_error",
        sql<string>`COUNT(*) OVER ()::text`.as("total"),
      ])
      .$if(Boolean(filter.chain), (qb) =>
        qb.where("p.chain", "=", String(filter.chain).toUpperCase()),
      )
      .$if(Boolean(filter.tenant), (qb) => qb.where("p.tenant", "=", String(filter.tenant)))
      .$if(Boolean(filter.merchant), (qb) => qb.where("p.merchant", "=", String(filter.merchant)))
      .$if(Boolean(filter.state), (qb) =>
        qb.where("p.state", "=", String(filter.state).toUpperCase()),
      )
      .$if(Boolean(filter.fundedOnly), (qb) =>
        qb.where(sql<boolean>`COALESCE(b.balance_base_units, 0) > 0`),
      )
      .orderBy("p.chain")
      .orderBy("p.tenant")
      .orderBy("p.merchant")
      .orderBy("p.derivation_index")
      .limit(limit)
      .offset(offset),

  groupTotals: (db: Db, asset: string) =>
    sql<{
      chain: string;
      merchant: string;
      onchain: string;
      addresses: string;
      observed: string;
      oldest: string | null;
    }>`
      SELECT p.chain, p.merchant,
             COALESCE(SUM(b.balance_base_units), 0)::text AS onchain,
             COUNT(*)::text AS addresses,
             COUNT(b.observed_at)::text AS observed,
             MIN(b.observed_at) AS oldest
        FROM pool_address p
        LEFT JOIN pool_address_balance b
          ON b.chain = p.chain AND b.address = p.address AND b.asset = ${asset}
       GROUP BY p.chain, p.merchant
    `.execute(db),
};

export const adminLedger = {
  entries: (
    db: Db,
    opts: { kindPrefix?: string | undefined; account?: string | undefined },
    limit: number,
  ) =>
    db
      .selectFrom("journal_entry as je")
      .select(["je.id", "je.kind", "je.occurred_at", "je.idempotency_key"])
      .$if(Boolean(opts.kindPrefix), (qb) => qb.where("je.kind", "like", `${opts.kindPrefix}%`))
      .$if(Boolean(opts.account), (qb) =>
        qb.where((eb) =>
          eb(
            "je.id",
            "in",
            eb
              .selectFrom("posting")
              .select("journal_entry_id")
              .where("account", "=", String(opts.account)),
          ),
        ),
      )
      .orderBy("je.occurred_at", "desc")
      .limit(limit),

  postingsForEntries: (db: Db, entryIds: readonly string[]) =>
    db
      .selectFrom("posting")
      .select(["journal_entry_id", "account", "asset", "amount", "direction"])
      .where("journal_entry_id", "in", entryIds)
      .orderBy("id"),
};

export const adminWebhooks = {
  list: (db: Db, status: string | undefined, limit: number) =>
    db
      .selectFrom("webhook_delivery")
      .select(["id", "tenant_id", "status", "attempts", "next_attempt", "last_error", "created_at"])
      .$if(Boolean(status), (qb) => qb.where("status", "=", String(status)))
      .orderBy("created_at", "desc")
      .limit(limit),

  byId: (db: Db, id: string) =>
    db
      .selectFrom("webhook_delivery")
      .select([
        "id",
        "tenant_id",
        "body",
        "status",
        "attempts",
        "next_attempt",
        "last_error",
        "created_at",
      ])
      .where("id", "=", id),

  endpointFor: (db: Db, tenantId: string) =>
    db.selectFrom("webhook_endpoint").select("url").where("tenant_id", "=", tenantId),

  replay: (db: Db, id: string) =>
    db
      .updateTable("webhook_delivery")
      .set({ status: "pending", attempts: 0, next_attempt: new Date(), last_error: null })
      .where("id", "=", id)
      .returning("id"),

  kill: (db: Db, id: string) =>
    db.updateTable("webhook_delivery").set({ status: "dead" }).where("id", "=", id).returning("id"),
};

export const adminAudit = {
  list: (db: Db, limit: number) =>
    db
      .selectFrom("admin_audit")
      .select(["id", "actor", "action", "target", "params", "result", "detail", "ip", "at"])
      .orderBy("at", "desc")
      .limit(limit),

  insert: (
    db: Db,
    row: {
      id: string;
      actor: string;
      action: string;
      target: string | null;
      params: string | null;
      result: string;
      detail: string | null;
      ip: string | null;
    },
  ) => db.insertInto("admin_audit").values(row),
};

export const adminErrors = {
  list: (db: Db, limit: number) =>
    db
      .selectFrom("error_log")
      .select(["id", "code", "message", "context", "at"])
      .orderBy("at", "desc")
      .limit(limit),
};
