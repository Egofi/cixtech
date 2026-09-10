import type { Db } from "@/types";
import { sql } from "kysely";

export const POOL_ADDRESS_COLUMNS = [
  "id",
  "tenant",
  "merchant",
  "chain",
  "derivation_index",
  "address",
  "state",
  "invoice_id",
  "cooldown_until",
  "gather_strategy",
] as const;

const ACTIVE_STATES = ["RESERVED", "IN_USE", "COOLING"] as const;

export const poolAddress = {
  all: (db: Db) => db.selectFrom("pool_address").select(POOL_ADDRESS_COLUMNS),

  byAddress: (db: Db, chain: string, address: string) =>
    poolAddress.all(db).where("chain", "=", chain).where("address", "=", address),

  forMerchant: (db: Db, tenant: string, merchant: string, chain: string) =>
    poolAddress
      .all(db)
      .where("tenant", "=", tenant)
      .where("merchant", "=", merchant)
      .where("chain", "=", chain)
      .orderBy("derivation_index"),

  active: (db: Db, chain: string) =>
    poolAddress.all(db).where("chain", "=", chain).where("state", "in", ACTIVE_STATES),

  addressesOrderedByIndex: (db: Db) =>
    db
      .selectFrom("pool_address")
      .select(["chain", "address"])
      .orderBy("chain")
      .orderBy("derivation_index"),

  addressesFor: (db: Db, tenantOrMerchant: string, chain: string) =>
    db
      .selectFrom("pool_address")
      .select("address")
      .where((eb) =>
        eb.or([eb("merchant", "=", tenantOrMerchant), eb("tenant", "=", tenantOrMerchant)]),
      )
      .where("chain", "=", chain),

  groups: (db: Db) =>
    db
      .selectFrom("pool_address")
      .select(["tenant", "merchant", "chain"])
      .distinct()
      .orderBy("chain")
      .orderBy("merchant"),

  /** Groups with at least one address in play — the reconciler's unit of work. */
  activeGroups: (db: Db) =>
    db
      .selectFrom("pool_address")
      .select(["tenant", "merchant", "chain"])
      .distinct()
      .where("state", "!=", "AVAILABLE")
      .orderBy("chain")
      .orderBy("tenant")
      .orderBy("merchant"),

  addressesInGroup: (db: Db, tenant: string, merchant: string, chain: string) =>
    db
      .selectFrom("pool_address")
      .select("address")
      .where("tenant", "=", tenant)
      .where("merchant", "=", merchant)
      .where("chain", "=", chain),

  /** A tenant's deposit addresses for one merchant account — the portal view. */
  forTenantMerchant: (db: Db, tenant: string, merchant: string) =>
    db
      .selectFrom("pool_address")
      .select(["chain", "address", "state", "cooldown_until"])
      .where("tenant", "=", tenant)
      .where("merchant", "=", merchant)
      .orderBy("chain")
      .orderBy("derivation_index"),

  summaryForTenant: (db: Db, tenant: string) =>
    db
      .selectFrom("pool_address")
      .select(["chain", "address", "state", "cooldown_until"])
      .where("tenant", "=", tenant)
      .orderBy("chain")
      .orderBy("derivation_index"),

  nextDerivationIndex: (db: Db, chain: string) =>
    db
      .selectFrom("pool_address")
      .select(sql<number>`COALESCE(MAX(derivation_index) + 1, 0)`.as("next"))
      .where("chain", "=", chain),

  insertReserved: (
    db: Db,
    row: {
      id: string;
      tenant: string;
      merchant: string;
      chain: string;
      derivation_index: number;
      address: string;
      state: string;
      invoice_id: string | null;
      gather_strategy: string;
    },
  ) => db.insertInto("pool_address").values(row).returning(POOL_ADDRESS_COLUMNS),

  /**
   * Atomic claim of the lowest free address. The row lock is the whole point —
   * two concurrent invoices must never receive the same deposit address — so
   * this one stays hand-written rather than assembled by the builder.
   */
  claimLowestAvailable: (
    db: Db,
    tenant: string,
    merchant: string,
    chain: string,
    invoiceId: string,
    reservedState: string,
  ) =>
    sql<Record<string, unknown>>`
      UPDATE pool_address SET state = ${reservedState}, invoice_id = ${invoiceId}
      WHERE id = (
        SELECT id FROM pool_address
        WHERE tenant = ${tenant} AND merchant = ${merchant} AND chain = ${chain}
          AND state = 'AVAILABLE'
        ORDER BY derivation_index
        LIMIT 1 FOR UPDATE SKIP LOCKED
      )
      RETURNING ${sql.raw(POOL_ADDRESS_COLUMNS.join(", "))}
    `.execute(db),

  transition: (
    db: Db,
    chain: string,
    address: string,
    from: string,
    to: string,
    change: { invoiceId?: string | null; cooldownUntil?: Date | null },
  ) => {
    // The old SQL carried a CASE WHEN $n::boolean dance because a string cannot
    // omit a column. A builder can simply not set it.
    const patch: { state: string; invoice_id?: string | null; cooldown_until?: Date | null } = {
      state: to,
    };
    if (change.invoiceId !== undefined) patch.invoice_id = change.invoiceId;
    if (change.cooldownUntil !== undefined) patch.cooldown_until = change.cooldownUntil;

    return db
      .updateTable("pool_address")
      .set(patch)
      .where("chain", "=", chain)
      .where("address", "=", address)
      .where("state", "=", from)
      .returning(POOL_ADDRESS_COLUMNS);
  },

  releaseCooled: (db: Db, now: Date) =>
    db
      .updateTable("pool_address")
      .set({ state: "AVAILABLE", invoice_id: null, cooldown_until: null })
      .where("state", "=", "COOLING")
      .where("cooldown_until", "<=", now)
      .returning("id"),
};
