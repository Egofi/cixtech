import type { Attribution, AttributionEntry } from "./attribution.js";
import type { PoolManager } from "./pool-manager.js";

/** Per-(tenant, merchant) fee in basis points. Replaced by the merchant fee policy later. */
export type FeePolicy = (tenant: string, merchant: string) => number;

/**
 * The real `Attribution` backed by the address pool (ADR 0009), replacing the
 * money-in slice's demo address book. Resolves a deposit address to its account
 * via the pool, then applies the fee policy.
 */
export class PooledAttribution implements Attribution {
  constructor(
    private readonly pool: PoolManager,
    private readonly feePolicy: FeePolicy,
  ) {}

  async resolve(chain: string, address: string): Promise<AttributionEntry | null> {
    const owner = await this.pool.resolve(chain, address);
    if (!owner) return null;
    return {
      tenant: owner.tenant,
      merchant: owner.merchant,
      feeBasisPoints: this.feePolicy(owner.tenant, owner.merchant),
    };
  }
}
