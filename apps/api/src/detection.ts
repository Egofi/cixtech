import type { PoolManager } from "@cixtech/attribution";
import type { DepositIngestor, DepositSource } from "@cixtech/chains";
import type { WebhookOutbox } from "./webhooks.js";

// DepositSource now lives with the chain ports (ADR 0016); re-exported for callers.
export type { DepositSource } from "@cixtech/chains";

/**
 * Detection loop (build spec §8). Polls the chain for deposits to every watched
 * pool address, credits confirmed ones through the ingestor (idempotent on
 * txId), and ENQUEUES a `deposit.confirmed` webhook to the outbox for each new
 * credit — delivery is the dispatcher's job, so a down endpoint loses nothing.
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
    private readonly outbox: WebhookOutbox,
  ) {}

  /**
   * Poll every chain once, isolating failures: a chain whose RPC is down fails
   * its own tick and is reported, but never stalls the others (ADR 0016).
   */
  async pollAll(chains: string[]): Promise<{ credited: number; failures: string[] }> {
    let credited = 0;
    const failures: string[] = [];
    for (const chain of chains) {
      try {
        credited += (await this.pollOnce(chain)).credited;
      } catch (err) {
        failures.push(`${chain}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return { credited, failures };
  }

  async pollOnce(chain: string): Promise<{ credited: number }> {
    const watched = await this.pool.activeAddresses(chain);
    let credited = 0;

    for (const addr of watched) {
      const deposits = await this.source.fetchInbound(chain, addr.address);
      for (const deposit of deposits) {
        const res = await this.ingestor.ingestConfirmed(deposit);
        if (res.status !== "credited") continue;
        credited++;
        await this.outbox.enqueue(addr.tenant, "deposit.confirmed", {
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
