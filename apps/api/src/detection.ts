import type { PoolManager } from "@cixtech/attribution";
import type { ChainDeposit, DepositIngestor } from "@cixtech/chains";
import type { WebhookDeliverer } from "./webhooks.js";

/** Fetches CONFIRMED inbound deposits for a watched address. Injected so tests use
 * fixtures and prod uses the Tron adapter (fetchInboundTrc20 + finality). */
export interface DepositSource {
  fetchInbound(chain: string, address: string): Promise<ChainDeposit[]>;
}

/**
 * Detection loop (build spec §8). Polls the chain for deposits to every watched
 * pool address, credits confirmed ones through the ingestor (idempotent on
 * txId), and fires a signed `deposit.confirmed` webhook for each new credit.
 * `pollOnce` is the unit of work; the server runs it on an interval.
 *
 * NOTE: `source` is responsible for only returning deposits past finality (the
 * Tron source applies the solidified-block rule); this loop trusts that.
 */
export class DepositWatcher {
  constructor(
    private readonly pool: PoolManager,
    private readonly source: DepositSource,
    private readonly ingestor: DepositIngestor,
    private readonly webhooks: WebhookDeliverer,
  ) {}

  async pollOnce(chain: string): Promise<{ credited: number }> {
    const watched = await this.pool.activeAddresses(chain);
    let credited = 0;

    for (const addr of watched) {
      const deposits = await this.source.fetchInbound(chain, addr.address);
      for (const deposit of deposits) {
        const res = await this.ingestor.ingestConfirmed(deposit);
        if (res.status !== "credited") continue;
        credited++;
        await this.webhooks.deliver(addr.tenant, "deposit.confirmed", {
          account: addr.merchant,
          chain,
          address: addr.address,
          txId: deposit.txId,
          asset: deposit.asset,
          amount: deposit.amountBaseUnits.toString(),
        });
      }
    }
    return { credited };
  }
}
