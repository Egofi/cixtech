import type { LedgerService } from "@cixtech/ledger";
import { Asset, LedgerAccountKey } from "@cixtech/types";

/**
 * One (tenant, merchant, chain) pool group and the on-chain addresses that back
 * its `pool_addr:{chain}:{merchant}` ledger account.
 */
export interface PoolGroup {
  tenant: string;
  merchant: string;
  chain: string;
  addresses: string[];
}

/** Enumerates every pool group to reconcile — typically a `SELECT DISTINCT` over the pool table. */
export interface PoolGroupEnumerator {
  poolGroups(): Promise<PoolGroup[]>;
}

/**
 * Reads an address's on-chain balance from a source that is INDEPENDENT of the
 * deposit detector (build spec §2). Using the same provider for both would make
 * the invariant agree with itself and prove nothing; a real deployment points this
 * at own-node/a second indexer, distinct from detection's source.
 */
export interface IndependentBalanceSource {
  balance(chain: string, address: string, asset: string): Promise<bigint>;
}

/** Trips the circuit breaker on confirmed external drift (ADR 0010 — freeze, never self-heal). */
export interface ReconcilerBreaker {
  trip(reason: string): Promise<void>;
}

export interface ExternalDriftRow {
  tenant: string;
  merchant: string;
  chain: string;
  asset: string;
  /** What the ledger says the pool holds (ASSET, positive). */
  ledger: bigint;
  /** What the independent chain source sums to across the group's addresses. */
  onChain: bigint;
}

export interface ExternalReconResult {
  drift: ExternalDriftRow[];
  tripped: boolean;
}

/**
 * External reconciler (build spec §8 `reconcile-external`, ADR 0010). For every
 * pool group and asset, compares the ledger's `pool_addr` ASSET balance against the
 * sum of the group's addresses read from an INDEPENDENT chain source. Any mismatch
 * is drift — theft, a missed deposit, or a bug — and trips the circuit breaker so
 * withdrawals freeze. It reports and freezes; it NEVER self-heals a mismatch.
 */
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
