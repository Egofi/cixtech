import type { Db } from "@/types";
import { sql } from "kysely";

export const gatherConfig = {
  /** Tenant row wins over the chain-wide default: `ORDER BY tenant DESC` picks it. */
  activeStrategy: (db: Db, chain: string, tenant: string, chainWide: string) =>
    db
      .selectFrom("gather_config")
      .select(["active_strategy", "tenant"])
      .where("chain", "=", chain)
      .where("tenant", "in", [tenant, chainWide])
      .orderBy("tenant", "desc")
      .limit(1),

  upsert: (
    db: Db,
    row: {
      chain: string;
      tenant: string;
      active_strategy: string;
      updated_by: string;
      approved_by: string;
      effective_at: Date;
    },
  ) =>
    db
      .insertInto("gather_config")
      .values(row)
      .onConflict((oc) =>
        oc.columns(["chain", "tenant"]).doUpdateSet((eb) => ({
          active_strategy: eb.ref("excluded.active_strategy"),
          updated_by: eb.ref("excluded.updated_by"),
          approved_by: eb.ref("excluded.approved_by"),
          effective_at: eb.ref("excluded.effective_at"),
        })),
      )
      .returning([
        "chain",
        "tenant",
        "active_strategy",
        "updated_by",
        "approved_by",
        "effective_at",
      ]),

  all: (db: Db) =>
    db
      .selectFrom("gather_config")
      .select(["chain", "tenant", "active_strategy", "updated_by", "approved_by", "effective_at"])
      .orderBy("chain")
      .orderBy("tenant"),
};

export const agentRule = {
  activeFor: (db: Db, tenantId: string) =>
    db
      .selectFrom("agent_rule")
      .selectAll()
      .where("tenant_id", "=", tenantId)
      .where("is_active", "=", true),

  insert: (
    db: Db,
    row: {
      id: string;
      tenant_id: string;
      name: string;
      condition_type: string;
      condition_threshold: string;
      action: string;
    },
  ) => db.insertInto("agent_rule").values(row),
};

export const aiBalances = {
  forTenantMerchants: (db: Db, tenantId: string) =>
    db
      .selectFrom("balance")
      .select(["account", "asset", "amount"])
      .where("account", "like", `merchant_available:${tenantId}:%`),

  forAccount: (db: Db, account: string) =>
    db.selectFrom("balance").select(["account", "asset", "amount"]).where("account", "=", account),
};

export const aiActivity = {
  /** The most recent entries that touched any of a tenant's ledger accounts. */
  recentEntriesForTenant: (db: Db, tenantId: string, limit: number) =>
    db
      .selectFrom("journal_entry as je")
      .select(["je.id", "je.kind", "je.occurred_at"])
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom("posting as p")
            .select(sql<number>`1`.as("one"))
            .whereRef("p.journal_entry_id", "=", "je.id")
            .where((inner) =>
              inner.or([
                inner("p.account", "like", `merchant_available:${tenantId}:%`),
                inner("p.account", "like", `merchant_pending_withdrawal:${tenantId}:%`),
                inner("p.account", "like", `compliance_suspense:${tenantId}%`),
                inner("p.account", "like", `egofi_fee_revenue:${tenantId}%`),
              ]),
            ),
        ),
      )
      .orderBy("je.occurred_at", "desc")
      .limit(limit),
};
