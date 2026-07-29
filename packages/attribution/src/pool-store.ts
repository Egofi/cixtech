import type { GatherStrategyKind } from "./gather-strategy.js";
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
  -- ADR 0011: the strategy this address was MINTED under. Load-bearing, not
  -- cosmetic — gather dispatches on this tag, never on the current toggle, so
  -- flipping the toggle can never strand an already-funded address.
  gather_strategy  text NOT NULL DEFAULT 'EOA_FUND_TRANSFER',
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (chain, address),
  UNIQUE (tenant, merchant, chain, derivation_index)
);
CREATE INDEX IF NOT EXISTS pool_address_claim ON pool_address(tenant, merchant, chain, state);

-- Upgrade path for databases created before the column existed. A schema module
-- must bring an EXISTING database up to date, not only create a new one:
-- \`CREATE TABLE IF NOT EXISTS\` is a no-op on a table that is already there, so
-- an additive change needs its own idempotent ALTER or it silently never lands.
ALTER TABLE pool_address
  ADD COLUMN IF NOT EXISTS gather_strategy text NOT NULL DEFAULT 'EOA_FUND_TRANSFER';
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
  /** The strategy that minted this address, and the only one that can drain it. */
  gatherStrategy: GatherStrategyKind;
}

export interface NewPoolAddress {
  tenant: string;
  merchant: string;
  chain: string;
  derivationIndex: number;
  address: string;
  invoiceId: string;
  gatherStrategy: GatherStrategyKind;
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
  /** All of a merchant's pool addresses on a chain, ordered by derivation index. */
  addressesForMerchant(tenant: string, merchant: string, chain: string): Promise<PoolAddressRow[]>;
  /** Addresses currently expecting or holding a deposit (RESERVED | IN_USE) — what detection watches. */
  activeAddresses(chain: string): Promise<PoolAddressRow[]>;
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
