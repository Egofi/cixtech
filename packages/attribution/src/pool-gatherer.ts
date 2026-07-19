import { AppError } from "@cixtech/errors";
import type { PoolManager } from "./pool-manager.js";

/** Reads a pool address's on-chain balance for an asset (the gather source of truth). */
export interface AddressBalance {
  balance(chain: string, address: string, asset: string): Promise<bigint>;
}

/** A pool address selected to fund a payout, with the Signer index that controls it. */
export interface GatheredSource {
  address: string;
  derivationIndex: number;
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
        return { address: a.address, derivationIndex: a.derivationIndex };
      }
    }
    throw new InsufficientPoolFundsError(
      `No single pool address holds ${amount} ${asset} for ${merchant} on ${chain}`,
      { context: { tenant, merchant, chain, asset, amount: amount.toString() } },
    );
  }
}
