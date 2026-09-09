import type { PoolState } from "@/attribution/pool-state.js";
import type { GatherStrategyKind, NewPoolAddress, StateChange } from "@/types";

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

  gatherStrategy: GatherStrategyKind;
}

export interface PoolStore {
  claimAvailable(
    tenant: string,
    merchant: string,
    chain: string,
    invoiceId: string,
  ): Promise<PoolAddressRow | null>;

  nextIndex(tenant: string, merchant: string, chain: string): Promise<number>;
  insertReserved(row: NewPoolAddress): Promise<PoolAddressRow>;
  findByAddress(chain: string, address: string): Promise<PoolAddressRow | null>;

  addressesForMerchant(tenant: string, merchant: string, chain: string): Promise<PoolAddressRow[]>;

  activeAddresses(chain: string): Promise<PoolAddressRow[]>;

  setState(
    chain: string,
    address: string,
    from: PoolState,
    to: PoolState,
    change?: StateChange,
  ): Promise<PoolAddressRow | null>;

  releaseCooled(now: Date): Promise<number>;
}
