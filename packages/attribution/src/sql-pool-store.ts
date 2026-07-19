import { randomUUID } from "node:crypto";
import type { SqlClient } from "@cixtech/ledger";
import { PoolState } from "./pool-state.js";
import type { NewPoolAddress, PoolAddressRow, PoolStore, StateChange } from "./pool-store.js";

interface Row {
  id: string;
  tenant: string;
  merchant: string;
  chain: string;
  derivation_index: number;
  address: string;
  state: string;
  invoice_id: string | null;
  cooldown_until: string | null;
}

const COLS =
  "id, tenant, merchant, chain, derivation_index, address, state, invoice_id, cooldown_until";

function toRow(r: Row): PoolAddressRow {
  return {
    id: r.id,
    tenant: r.tenant,
    merchant: r.merchant,
    chain: r.chain,
    derivationIndex: Number(r.derivation_index),
    address: r.address,
    state: r.state as PoolState,
    invoiceId: r.invoice_id,
    cooldownUntil: r.cooldown_until ? new Date(r.cooldown_until) : null,
  };
}

export class SqlPoolStore implements PoolStore {
  constructor(private readonly sql: SqlClient) {}

  async claimAvailable(
    tenant: string,
    merchant: string,
    chain: string,
    invoiceId: string,
  ): Promise<PoolAddressRow | null> {
    const r = await this.sql.query<Row>(
      `UPDATE pool_address SET state = $5, invoice_id = $4
       WHERE id = (
         SELECT id FROM pool_address
         WHERE tenant = $1 AND merchant = $2 AND chain = $3 AND state = 'AVAILABLE'
         ORDER BY derivation_index
         LIMIT 1 FOR UPDATE SKIP LOCKED
       )
       RETURNING ${COLS}`,
      [tenant, merchant, chain, invoiceId, PoolState.Reserved],
    );
    return r.rows[0] ? toRow(r.rows[0]) : null;
  }

  async nextIndex(_tenant: string, _merchant: string, chain: string): Promise<number> {
    // Global per chain: one engine signing key derives every merchant's addresses,
    // so indices must be unique across merchants (two accounts at index 0 would
    // collide on the same address). Per-merchant key domains would scope this.
    const r = await this.sql.query<{ next: number }>(
      "SELECT COALESCE(MAX(derivation_index) + 1, 0) AS next FROM pool_address WHERE chain = $1",
      [chain],
    );
    return Number(r.rows[0]?.next ?? 0);
  }

  async insertReserved(row: NewPoolAddress): Promise<PoolAddressRow> {
    const r = await this.sql.query<Row>(
      `INSERT INTO pool_address (id, tenant, merchant, chain, derivation_index, address, state, invoice_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING ${COLS}`,
      [
        randomUUID(),
        row.tenant,
        row.merchant,
        row.chain,
        row.derivationIndex,
        row.address,
        PoolState.Reserved,
        row.invoiceId,
      ],
    );
    const inserted = r.rows[0];
    if (!inserted) throw new Error("pool_address insert returned no row");
    return toRow(inserted);
  }

  async findByAddress(chain: string, address: string): Promise<PoolAddressRow | null> {
    const r = await this.sql.query<Row>(
      `SELECT ${COLS} FROM pool_address WHERE chain = $1 AND address = $2`,
      [chain, address],
    );
    return r.rows[0] ? toRow(r.rows[0]) : null;
  }

  async addressesForMerchant(
    tenant: string,
    merchant: string,
    chain: string,
  ): Promise<PoolAddressRow[]> {
    const r = await this.sql.query<Row>(
      `SELECT ${COLS} FROM pool_address
       WHERE tenant = $1 AND merchant = $2 AND chain = $3
       ORDER BY derivation_index`,
      [tenant, merchant, chain],
    );
    return r.rows.map(toRow);
  }

  async setState(
    chain: string,
    address: string,
    from: PoolState,
    to: PoolState,
    change: StateChange = {},
  ): Promise<PoolAddressRow | null> {
    const invoiceId = change.invoiceId === undefined ? null : change.invoiceId;
    const cooldown = change.cooldownUntil ? change.cooldownUntil.toISOString() : null;
    const r = await this.sql.query<Row>(
      `UPDATE pool_address
       SET state = $4,
           invoice_id = CASE WHEN $5::boolean THEN $6 ELSE invoice_id END,
           cooldown_until = CASE WHEN $7::boolean THEN $8 ELSE cooldown_until END
       WHERE chain = $1 AND address = $2 AND state = $3
       RETURNING ${COLS}`,
      [
        chain,
        address,
        from,
        to,
        change.invoiceId !== undefined,
        invoiceId,
        change.cooldownUntil !== undefined,
        cooldown,
      ],
    );
    return r.rows[0] ? toRow(r.rows[0]) : null;
  }

  async releaseCooled(now: Date): Promise<number> {
    const r = await this.sql.query<Row>(
      `UPDATE pool_address
       SET state = 'AVAILABLE', invoice_id = NULL, cooldown_until = NULL
       WHERE state = 'COOLING' AND cooldown_until <= $1
       RETURNING ${COLS}`,
      [now.toISOString()],
    );
    return r.rows.length;
  }
}
