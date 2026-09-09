import type { LedgerService } from "@/services";
import {
  Asset,
  type ExternalDriftRow,
  type ExternalReconResult,
  LedgerAccountKey,
  type PoolGroup,
} from "@/types";

export interface PoolGroupEnumerator {
  poolGroups(): Promise<PoolGroup[]>;
}

export interface IndependentBalanceSource {
  balance(chain: string, address: string, asset: string): Promise<bigint>;
}

export interface ReconcilerBreaker {
  trip(reason: string): Promise<void>;
}

export class ExternalReconciler {
  constructor(
    private readonly ledger: LedgerService,
    private readonly enumerator: PoolGroupEnumerator,
    private readonly independent: IndependentBalanceSource,
    private readonly assets: readonly string[],
    private readonly breaker?: ReconcilerBreaker,
  ) {}

  async run(): Promise<ExternalReconResult> {
    const drift: ExternalDriftRow[] = [];
    for (const group of await this.enumerator.poolGroups()) {
      for (const asset of this.assets) {
        const ledgerBal = await this.ledger.getBalance(
          LedgerAccountKey(`pool_addr:${group.chain}:${group.merchant}`),
          Asset(asset),
        );
        let onChain = 0n;
        for (const address of group.addresses) {
          onChain += await this.independent.balance(group.chain, address, asset);
        }
        if (ledgerBal !== onChain) {
          drift.push({
            tenant: group.tenant,
            merchant: group.merchant,
            chain: group.chain,
            asset,
            ledger: ledgerBal,
            onChain,
          });
        }
      }
    }
    let tripped = false;
    if (drift.length > 0 && this.breaker) {
      const summary = drift
        .map((d) => `${d.chain}/${d.merchant}/${d.asset}: ledger ${d.ledger} vs chain ${d.onChain}`)
        .join("; ");
      await this.breaker.trip(`External reconciliation drift: ${summary}`);
      tripped = true;
    }
    return { drift, tripped };
  }
}
