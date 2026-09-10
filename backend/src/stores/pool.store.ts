import { randomUUID } from "node:crypto";
import type { PoolState } from "@/attribution/pool-state.js";
import { PoolState as State } from "@/attribution/pool-state.js";
import type { PoolAddressRow, PoolStore } from "@/attribution/pool.port.js";
import { kyselyFor } from "@/postgres";
import { poolAddress } from "@/queries";
import type { Db, GatherStrategyKind, NewPoolAddress, SqlClient, StateChange } from "@/types";

interface Row {
  id: string;
  tenant: string;
  merchant: string;
  chain: string;
  derivation_index: number;
  address: string;
  state: string;
  invoice_id: string | null;
  cooldown_until: Date | string | null;
  gather_strategy: string;
}

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
    gatherStrategy: r.gather_strategy as GatherStrategyKind,
  };
}

export class SqlPoolStore implements PoolStore {
  private readonly db: Db;

  constructor(sql: SqlClient) {
    this.db = kyselyFor(sql);
  }

  async claimAvailable(
    tenant: string,
    merchant: string,
    chain: string,
    invoiceId: string,
  ): Promise<PoolAddressRow | null> {
    const { rows } = await poolAddress.claimLowestAvailable(
      this.db,
      tenant,
      merchant,
      chain,
      invoiceId,
      State.Reserved,
    );
    const claimed = rows[0] as Row | undefined;
    return claimed ? toRow(claimed) : null;
  }

  async nextIndex(_tenant: string, _merchant: string, chain: string): Promise<number> {
    const row = await poolAddress.nextDerivationIndex(this.db, chain).executeTakeFirst();
    return Number(row?.next ?? 0);
  }

  async insertReserved(row: NewPoolAddress): Promise<PoolAddressRow> {
    const inserted = await poolAddress
      .insertReserved(this.db, {
        id: randomUUID(),
        tenant: row.tenant,
        merchant: row.merchant,
        chain: row.chain,
        derivation_index: row.derivationIndex,
        address: row.address,
        state: State.Reserved,
        invoice_id: row.invoiceId,
        gather_strategy: row.gatherStrategy,
      })
      .executeTakeFirst();

    if (!inserted) throw new Error("pool_address insert returned no row");
    return toRow(inserted);
  }

  async findByAddress(chain: string, address: string): Promise<PoolAddressRow | null> {
    const row = await poolAddress.byAddress(this.db, chain, address).executeTakeFirst();
    return row ? toRow(row) : null;
  }

  async addressesForMerchant(
    tenant: string,
    merchant: string,
    chain: string,
  ): Promise<PoolAddressRow[]> {
    const rows = await poolAddress.forMerchant(this.db, tenant, merchant, chain).execute();
    return rows.map(toRow);
  }

  async activeAddresses(chain: string): Promise<PoolAddressRow[]> {
    const rows = await poolAddress.active(this.db, chain).execute();
    return rows.map(toRow);
  }

  async setState(
    chain: string,
    address: string,
    from: PoolState,
    to: PoolState,
    change: StateChange = {},
  ): Promise<PoolAddressRow | null> {
    const row = await poolAddress
      .transition(this.db, chain, address, from, to, change)
      .executeTakeFirst();
    return row ? toRow(row) : null;
  }

  async releaseCooled(now: Date): Promise<number> {
    const rows = await poolAddress.releaseCooled(this.db, now).execute();
    return rows.length;
  }
}
