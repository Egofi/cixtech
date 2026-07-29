import { AppError } from "@cixtech/errors";
import type { GatherStrategyKind } from "./gather-strategy.js";
import { type PoolAction, PoolState, nextPoolState } from "./pool-state.js";
import type { PoolAddressRow, PoolStore } from "./pool-store.js";

/** Derives a receive address for a chain from a merchant's account xpub at an index. */
export type AddressDeriver = (chain: string, xpub: string, index: number) => string;

/**
 * Which strategy NEW addresses mint under (ADR 0011). Reads the current toggle;
 * the value is then RECORDED on the address and is what drains it forever after.
 */
export type ActiveStrategyLookup = (
  chain: string,
  tenant: string,
) => Promise<GatherStrategyKind> | GatherStrategyKind;

export interface PoolManagerConfig {
  /** How long an address cools off after a deposit finalizes + the window closes. */
  cooldownMs: number;
  /**
   * Resolves the mint-time strategy. Defaults to fund-then-transfer on plain EOAs,
   * which is what the engine ships (ADR 0011 sequencing).
   */
  activeStrategy?: ActiveStrategyLookup;
}

export class PoolAddressNotFoundError extends AppError {
  readonly code = "POOL_ADDRESS_NOT_FOUND";
}
export class PoolConcurrentModificationError extends AppError {
  readonly code = "POOL_CONCURRENT_MODIFICATION";
}

/**
 * Owns the deposit-address pool lifecycle (ADR 0009). `assign` hands an invoice
 * an exclusive address — reusing an AVAILABLE one, or minting the next derived
 * index when the pool is exhausted. `resolve` turns a deposit address back into
 * its owning account. Funds never move here; only the address state does.
 */
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
    // The strategy is resolved ONCE, here, and stored on the row. Everything
    // downstream reads the stored tag — never the toggle — so a later flip cannot
    // strand this address (ADR 0011).
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

  /** All of a merchant's pool addresses on a chain (for gathering payout sources). */
  addressesForMerchant(tenant: string, merchant: string, chain: string): Promise<PoolAddressRow[]> {
    return this.store.addressesForMerchant(tenant, merchant, chain);
  }

  /** Addresses detection should watch — currently expecting or holding a deposit. */
  activeAddresses(chain: string): Promise<PoolAddressRow[]> {
    return this.store.activeAddresses(chain);
  }

  /** The owning account of a deposit address, or null if unknown / not currently assigned. */
  async resolve(
    chain: string,
    address: string,
  ): Promise<{ tenant: string; merchant: string } | null> {
    const row = await this.store.findByAddress(chain, address);
    if (!row || row.state === PoolState.Available) return null;
    return { tenant: row.tenant, merchant: row.merchant };
  }

  /** RESERVED → IN_USE when a deposit to the address is observed. */
  markInUse(chain: string, address: string): Promise<PoolAddressRow> {
    return this.apply(chain, address, "detect");
  }

  /** IN_USE → COOLING once the deposit is final and the payment window has closed. */
  cool(chain: string, address: string): Promise<PoolAddressRow> {
    return this.apply(chain, address, "cool", {
      cooldownUntil: new Date(Date.now() + this.config.cooldownMs),
    });
  }

  /** COOLING/RESERVED → AVAILABLE (cool-off elapsed, or an unpaid invoice expired). */
  release(chain: string, address: string): Promise<PoolAddressRow> {
    return this.apply(chain, address, "release", { invoiceId: null, cooldownUntil: null });
  }

  /** Batch-release every address whose cool-off has elapsed. Returns how many. */
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
    const to = nextPoolState(row.state, action); // validates the transition
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
