import type { PoolState } from "./pool-state.js";

/**
 * Per-(merchant, chain) pool of deposit addresses (ADR 0009). Exclusive
 * assignment — one invoice per address at a time — makes attribution trivial:
 * any deposit to an assigned address belongs to its invoice's account. Addresses
 * hold balance across states; there is no SWEPT state.
 */
export const POOL_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS pool_address (
  id               text PRIMARY KEY,
  tenant           text NOT NULL,
  merchant         text NOT NULL,
  chain            text NOT NULL,
  derivation_index int  NOT NULL,
  address          text NOT NULL,
  state            text NOT NULL,
  invoice_id       text,
  cooldown_until   timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (chain, address),
  UNIQUE (tenant, merchant, chain, derivation_index)
);
CREATE INDEX IF NOT EXISTS pool_address_claim ON pool_address(tenant, merchant, chain, state);
`;

export interface PoolAddressRow {
  id: string;
  tenant: string;
  merchant: string;
  chain: string;
  derivationIndex: number;
  address: string;
  state: PoolState;
  invoiceId: string | null;
  cooldownUntil: Date | null;
}

export interface NewPoolAddress {
  tenant: string;
  merchant: string;
  chain: string;
  derivationIndex: number;
  address: string;
  invoiceId: string;
}

export interface StateChange {
  invoiceId?: string | null;
  cooldownUntil?: Date | null;
}

export interface PoolStore {
  /** Atomically claim the lowest-index AVAILABLE address for this pool (FOR UPDATE SKIP LOCKED). */
  claimAvailable(
    tenant: string,
    merchant: string,
    chain: string,
    invoiceId: string,
  ): Promise<PoolAddressRow | null>;
  /** Next BIP44 index to mint for this pool. */
  nextIndex(tenant: string, merchant: string, chain: string): Promise<number>;
  insertReserved(row: NewPoolAddress): Promise<PoolAddressRow>;
  findByAddress(chain: string, address: string): Promise<PoolAddressRow | null>;
  /** Guarded transition: only applies if the row is still in `from`. Returns null on a miss. */
  setState(
    chain: string,
    address: string,
    from: PoolState,
    to: PoolState,
    change?: StateChange,
  ): Promise<PoolAddressRow | null>;
  /** Sweeper: COOLING → AVAILABLE for every address whose cool-off has elapsed. Returns the count. */
  releaseCooled(now: Date): Promise<number>;
}
