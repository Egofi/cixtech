import type { PoolManager } from "@/attribution";
import type { DepositSource } from "../chain-adapter.js";
import type { WebhookOutbox } from "../webhooks.js";
import type { DepositIngestor } from "./deposit-ingestor.js";

// DepositSource lives with the chain ports (ADR 0016); re-exported for callers.
export type { DepositSource } from "../chain-adapter.js";

/**
 * Detection loop (build spec §8). Polls the chain for deposits to every watched
 * pool address, credits confirmed ones through the ingestor (idempotent on
 * txId), and ENQUEUES a `deposit.confirmed` webhook to the outbox for each new
 * credit — delivery is the dispatcher's job, so a down endpoint loses nothing.
 * `pollOnce` is the unit of work. It lives in this package rather than in the API
 * because the WORKER owns detection now: running it in the API meant every API
 * replica polled every chain independently, so scaling the API horizontally
 * multiplied the RPC load and had the replicas racing to ingest the same
 * deposits. Both apps can reach it from here.
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

  async pollOnce(chain: string): Promise<{ credited: number; reversed: number }> {
    const watched = await this.pool.activeAddresses(chain);
    let credited = 0;
    let reversed = 0;

    for (const addr of watched) {
      const deposits = await this.source.fetchInbound(chain, addr.address);
      for (const deposit of deposits) {
        const res = await this.ingestor.ingestConfirmed(deposit);
        if (res.status === "credited") {
          credited++;
          await this.outbox.enqueue(addr.tenant, "deposit.confirmed", {
            account: addr.merchant,
            chain,
            address: addr.address,
            txId: deposit.txId,
            asset: deposit.asset,
            amount: deposit.amountBaseUnits.toString(),
          });
        } else if (res.status === "quarantined") {
          // Held for compliance (§14): notify, but never as a spendable credit.
          await this.outbox.enqueue(addr.tenant, "compliance.hold", {
            account: addr.merchant,
            chain,
            address: addr.address,
            txId: deposit.txId,
            asset: deposit.asset,
            amount: deposit.amountBaseUnits.toString(),
          });
        }
      }

      // Deep-reorg reversal (§9): a source that can detect a post-finality reorg
      // returns the vanished deposits; we compensate the ledger and notify.
      if (this.source.reorged) {
        for (const gone of await this.source.reorged(chain, addr.address)) {
          const rev = await this.ingestor.reverseCredit(gone);
          if (rev.status !== "reversed") continue;
          reversed++;
          await this.outbox.enqueue(addr.tenant, "deposit.reorged", {
            account: addr.merchant,
            chain,
            address: addr.address,
            txId: gone.txId,
            asset: gone.asset,
            amount: gone.amountBaseUnits.toString(),
          });
        }
      }
    }
    return { credited, reversed };
  }
}
