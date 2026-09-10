import type { PoolAddressRow, PoolStore } from "@/attribution/pool.port.js";
import { PoolAddressNotFoundError, PoolConcurrentModificationError } from "@/common";
import type { GatherStrategyKind, PoolAction } from "@/types";

import { PoolState, nextPoolState } from "./pool-state.js";

export type AddressDeriver = (chain: string, xpub: string, index: number) => string;

export type ActiveStrategyLookup = (
  chain: string,
  tenant: string,
) => Promise<GatherStrategyKind> | GatherStrategyKind;

export interface PoolManagerConfig {
  cooldownMs: number;

  activeStrategy?: ActiveStrategyLookup;
}

export class PoolManager {
  constructor(
    private readonly store: PoolStore,
    private readonly derive: AddressDeriver,
    private readonly config: PoolManagerConfig,
  ) {}

  async assign(
    tenant: string,
    merchant: string,
    chain: string,
    invoiceId: string,
    xpub: string,
  ): Promise<string> {
    const claimed = await this.store.claimAvailable(tenant, merchant, chain, invoiceId);
    if (claimed) return claimed.address;

    const derivationIndex = await this.store.nextIndex(tenant, merchant, chain);

    const gatherStrategy = await this.resolveStrategy(chain, tenant);
    const address = this.derive(chain, xpub, derivationIndex);
    const row = await this.store.insertReserved({
      tenant,
      merchant,
      chain,
      derivationIndex,
      address,
      invoiceId,
      gatherStrategy,
    });
    return row.address;
  }

  private async resolveStrategy(chain: string, tenant: string): Promise<GatherStrategyKind> {
    if (!this.config.activeStrategy) return "EOA_FUND_TRANSFER";
    return this.config.activeStrategy(chain, tenant);
  }

  addressesForMerchant(tenant: string, merchant: string, chain: string): Promise<PoolAddressRow[]> {
    return this.store.addressesForMerchant(tenant, merchant, chain);
  }

  activeAddresses(chain: string): Promise<PoolAddressRow[]> {
    return this.store.activeAddresses(chain);
  }

  async resolve(
    chain: string,
    address: string,
  ): Promise<{ tenant: string; merchant: string } | null> {
    const row = await this.store.findByAddress(chain, address);
    if (!row || row.state === PoolState.Available) return null;
    return { tenant: row.tenant, merchant: row.merchant };
  }

  markInUse(chain: string, address: string): Promise<PoolAddressRow> {
    return this.apply(chain, address, "detect");
  }

  cool(chain: string, address: string): Promise<PoolAddressRow> {
    return this.apply(chain, address, "cool", {
      cooldownUntil: new Date(Date.now() + this.config.cooldownMs),
    });
  }

  release(chain: string, address: string): Promise<PoolAddressRow> {
    return this.apply(chain, address, "release", { invoiceId: null, cooldownUntil: null });
  }

  releaseCooled(now: Date = new Date()): Promise<number> {
    return this.store.releaseCooled(now);
  }

  private async apply(
    chain: string,
    address: string,
    action: PoolAction,
    change?: { invoiceId?: string | null; cooldownUntil?: Date | null },
  ): Promise<PoolAddressRow> {
    const row = await this.store.findByAddress(chain, address);
    if (!row) {
      throw new PoolAddressNotFoundError(`No pool address ${address} on ${chain}`, {
        context: { chain, address },
      });
    }
    const to = nextPoolState(row.state, action);
    const updated = await this.store.setState(chain, address, row.state, to, change);
    if (!updated) {
      throw new PoolConcurrentModificationError(
        `Pool address ${address} changed state concurrently during ${action}`,
        { context: { chain, address, action } },
      );
    }
    return updated;
  }
}
