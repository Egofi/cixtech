import type { PoolManager } from "@/attribution";
import type { WebhookOutbox } from "@/chains";
import type { DepositSource } from "../chain-adapter.js";

import type { DepositIngestor } from "./deposit-ingestor.js";

export type { DepositSource } from "../chain-adapter.js";

export class DepositWatcher {
  constructor(
    private readonly pool: PoolManager,
    private readonly source: DepositSource,
    private readonly ingestor: DepositIngestor,
    private readonly outbox: WebhookOutbox,
  ) {}

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
