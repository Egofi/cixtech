import type { AttributionEntry } from "@/types";
import type { Attribution } from "./attribution.js";
import type { PoolManager } from "./pool-manager.js";

export type FeePolicy = (tenant: string, merchant: string) => number;

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
