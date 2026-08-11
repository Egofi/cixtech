import type { AddressBalance, GatherStrategyKind, PoolManager } from "@cixtech/attribution";
import { normalBalance } from "@cixtech/ledger";
import type { SqlClient } from "@cixtech/ledger";
import type { LedgerAccountKey } from "@cixtech/types";

/** One address the platform can take its accrued fee from, and how much. */
export interface FeeSweepLeg {
  address: string;
  derivationIndex: number;
  gatherStrategy: GatherStrategyKind;
  amountBaseUnits: bigint;
}

export interface FeeSweepPlan {
  tenant: string;
  merchant: string;
  chain: string;
  asset: string;
  /** The platform's total accrued claim against this merchant, across all chains. */
  claimBaseUnits: bigint;
  /** What can actually be moved on THIS chain right now. */
  legs: FeeSweepLeg[];
  totalBaseUnits: bigint;
  /** Addresses holding a claim too small to be worth its own transfer. */
  skippedDust: number;
}

export interface FeeSweepPlannerOptions {
  /**
   * Below this, a residual is left where it is. A transfer costs gas; moving
   * value worth less than the gas to move it destroys money rather than
   * collecting it, and it churns the pool for nothing.
   */
  dustThresholdBaseUnits?: bigint;
}

/**
 * Works out what the platform is owed out of a merchant's pool addresses, and
 * which addresses can pay it.
 *
 * **Where the claim comes from.** The fee is taken at deposit: the merchant is
 * credited 99.5% and `egofi_fee_revenue` the rest, while 100% of the coins land
 * in the pool address. So for any merchant:
 *
 *     claim = Σ pool_addr(merchant)  −  Σ merchant liabilities
 *
 * That difference *is* the accrued fee physically sitting in their addresses. It
 * needs no new account key and it cannot over-sweep, because it is derived from
 * the liabilities themselves — the moment the platform takes a unit, `pool_addr`
 * falls and the claim shrinks with it.
 *
 * **A known asymmetry.** Liabilities are not chain-scoped (`merchant_available:
 * {tenant}:{merchant}`) while pool balances are (`pool_addr:{chain}:{merchant}`).
 * The claim is therefore computed per merchant and consumed opportunistically on
 * whichever chain is being touched. It drains correctly over time and never
 * exceeds the true claim; inventing per-chain liability accounts to make the
 * arithmetic prettier would be a much larger change for no additional safety.
 *
 * **On-chain balances, not cached ones.** This decides a transfer, so it reads
 * the chain. `pool_address_balance` is for the console.
 */
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

  /** The platform's accrued claim against one merchant for one asset. */
  async claim(tenant: string, merchant: string, asset: string): Promise<bigint> {
    const { rows } = await this.sql.query<{ account: string; amount: string }>(
      `SELECT account, amount FROM balance
        WHERE asset = $1
          AND (account LIKE 'pool_addr:%:' || $2 OR account LIKE 'merchant\\_%:' || $3 || ':' || $2)`,
      [asset, merchant, tenant],
    );

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

  /**
   * Which of the merchant's addresses on `chain` can settle the claim.
   *
   * `reserved` is how much of an address's balance is already committed to a
   * merchant payout in the same pass. Without it the fee legs and the payout
   * legs would both plan to spend the same coins and the second transfer would
   * fail on chain — the one failure mode that turns a bookkeeping improvement
   * into a stuck payout.
   */
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
