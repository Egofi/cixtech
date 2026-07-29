import { AppError } from "@cixtech/errors";
import type { GatherStrategyKind } from "./gather-strategy.js";
import type { PoolManager } from "./pool-manager.js";

/** Reads a pool address's on-chain balance for an asset (the gather source of truth). */
export interface AddressBalance {
  balance(chain: string, address: string, asset: string): Promise<bigint>;
}

/** A pool address selected to fund a payout, with the Signer index that controls it. */
export interface GatheredSource {
  address: string;
  derivationIndex: number;
  /**
   * The strategy this address was minted under (ADR 0011). Carried on the leg so
   * the payout drains it with the mechanism that created it, whatever the current
   * toggle says.
   */
  gatherStrategy: GatherStrategyKind;
}

/** One leg of a multi-address gather: how much to pull from this pool address. */
export interface GatheredLeg extends GatheredSource {
  /** Base units to spend from this address (≤ its on-chain balance). */
  amountBaseUnits: bigint;
}

export class InsufficientPoolFundsError extends AppError {
  readonly code = "POOL_INSUFFICIENT_FUNDS";
}

/**
 * Chooses which of a merchant's pool addresses funds a payout (ADR 0009 §6.3).
 * First cut: pick a single address whose on-chain balance covers the amount —
 * the common case where one deposit funds one payout. Multi-address
 * consolidation (a gather across several addresses, one tx each on Tron/EVM) is
 * the next step; until then a payout larger than any single address is rejected
 * rather than silently mishandled.
 */
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

  /**
   * Gather funding for a payout across as MANY of the merchant's pool addresses as
   * it takes to cover `amount` (ADR 0009 §6.3). Deposits accumulate across a
   * bounded pool, so a payout larger than any single address is normal; this
   * consolidates them. Prefers larger balances first (fewest legs → fewest
   * on-chain transfers on EVM/Tron), takes the exact remainder from the last leg,
   * and rejects only when the merchant's total on-chain balance genuinely falls
   * short — never silently underpays.
   */
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
