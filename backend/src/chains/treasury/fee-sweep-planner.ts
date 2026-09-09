import type { AddressBalance, PoolManager } from "@/attribution";
import { normalBalance } from "@/ledger";
import { kyselyFor } from "@/postgres";
import { sweepBalances } from "@/queries";

import type {
  FeeSweepLeg,
  FeeSweepPlan,
  FeeSweepPlannerOptions,
  GatherStrategyKind,
  LedgerAccountKey,
  SqlClient,
} from "@/types";

export class FeeSweepPlanner {
  private readonly dust: bigint;

  constructor(
    private readonly sql: SqlClient,
    private readonly pool: PoolManager,
    private readonly balances: AddressBalance,
    options: FeeSweepPlannerOptions = {},
  ) {
    this.dust = options.dustThresholdBaseUnits ?? 0n;
  }

  async claim(tenant: string, merchant: string, asset: string): Promise<bigint> {
    const rows = await sweepBalances
      .forClaim(kyselyFor(this.sql), asset, merchant, tenant)
      .execute();

    let poolAssets = 0n;
    let liabilities = 0n;
    for (const r of rows) {
      const key = r.account as LedgerAccountKey;
      const magnitude = normalBalance(key, BigInt(r.amount));
      if (r.account.startsWith("pool_addr:")) poolAssets += magnitude;
      else liabilities += magnitude;
    }

    const surplus = poolAssets - liabilities;
    return surplus > 0n ? surplus : 0n;
  }

  async plan(
    tenant: string,
    merchant: string,
    chain: string,
    asset: string,
    reserved: ReadonlyMap<string, bigint> = new Map(),
  ): Promise<FeeSweepPlan> {
    const claimBaseUnits = await this.claim(tenant, merchant, asset);
    const empty: FeeSweepPlan = {
      tenant,
      merchant,
      chain,
      asset,
      claimBaseUnits,
      legs: [],
      totalBaseUnits: 0n,
      skippedDust: 0,
    };
    if (claimBaseUnits <= 0n) return empty;

    const addresses = await this.pool.addressesForMerchant(tenant, merchant, chain);
    const legs: FeeSweepLeg[] = [];
    let remaining = claimBaseUnits;
    let skippedDust = 0;

    for (const a of addresses) {
      if (remaining <= 0n) break;
      const onChain = await this.balances.balance(chain, a.address, asset);
      const spoken = reserved.get(a.address) ?? 0n;
      const free = onChain - spoken;
      if (free <= 0n) continue;

      const take = free < remaining ? free : remaining;
      if (take < this.dust) {
        skippedDust++;
        continue;
      }
      legs.push({
        address: a.address,
        derivationIndex: a.derivationIndex,
        gatherStrategy: a.gatherStrategy,
        amountBaseUnits: take,
      });
      remaining -= take;
    }

    return {
      ...empty,
      legs,
      totalBaseUnits: legs.reduce((sum, l) => sum + l.amountBaseUnits, 0n),
      skippedDust,
    };
  }
}
