import { InsufficientPoolFundsError } from "@/common";
import type { GatherStrategyKind, GatheredLeg, GatheredSource } from "@/types";

import type { PoolManager } from "./pool-manager.js";

export interface AddressBalance {
  balance(chain: string, address: string, asset: string): Promise<bigint>;
}

export class PoolGatherer {
  constructor(
    private readonly pool: PoolManager,
    private readonly balances: AddressBalance,
  ) {}

  async gatherSingle(
    tenant: string,
    merchant: string,
    chain: string,
    asset: string,
    amount: bigint,
  ): Promise<GatheredSource> {
    const addresses = await this.pool.addressesForMerchant(tenant, merchant, chain);
    for (const a of addresses) {
      const bal = await this.balances.balance(chain, a.address, asset);
      if (bal >= amount) {
        return {
          address: a.address,
          derivationIndex: a.derivationIndex,
          gatherStrategy: a.gatherStrategy,
        };
      }
    }
    throw new InsufficientPoolFundsError(
      `No single pool address holds ${amount} ${asset} for ${merchant} on ${chain}`,
      { context: { tenant, merchant, chain, asset, amount: amount.toString() } },
    );
  }

  async gather(
    tenant: string,
    merchant: string,
    chain: string,
    asset: string,
    amount: bigint,
  ): Promise<GatheredLeg[]> {
    if (amount <= 0n) {
      throw new InsufficientPoolFundsError(`Gather amount must be positive, got ${amount}`, {
        context: { tenant, merchant, chain, asset },
      });
    }
    const addresses = await this.pool.addressesForMerchant(tenant, merchant, chain);
    const funded: Array<GatheredSource & { balance: bigint }> = [];
    for (const a of addresses) {
      const balance = await this.balances.balance(chain, a.address, asset);
      if (balance > 0n) {
        funded.push({
          address: a.address,
          derivationIndex: a.derivationIndex,
          gatherStrategy: a.gatherStrategy,
          balance,
        });
      }
    }
    funded.sort((x, y) => (y.balance > x.balance ? 1 : y.balance < x.balance ? -1 : 0));

    const legs: GatheredLeg[] = [];
    let remaining = amount;
    for (const f of funded) {
      if (remaining <= 0n) break;
      const take = f.balance < remaining ? f.balance : remaining;
      legs.push({
        address: f.address,
        derivationIndex: f.derivationIndex,
        gatherStrategy: f.gatherStrategy,
        amountBaseUnits: take,
      });
      remaining -= take;
    }
    if (remaining > 0n) {
      const total = funded.reduce((s, f) => s + f.balance, 0n);
      throw new InsufficientPoolFundsError(
        `Merchant ${merchant} holds ${total} ${asset} on ${chain}, needs ${amount}`,
        {
          context: {
            tenant,
            merchant,
            chain,
            asset,
            have: total.toString(),
            need: amount.toString(),
          },
        },
      );
    }
    return legs;
  }
}
