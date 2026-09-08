import type { Asset, LedgerAccountKey } from "@/types";

/** A materialized balance that disagrees with the signed sum of its postings. */
export interface DriftRow {
  account: LedgerAccountKey;
  asset: Asset;
  materialized: bigint;
  fromHistory: bigint;
}

/**
 * A store that can check its materialized balances against posting history
 * (property 12). An empty result means consistent; a non-empty result means a bug
 * or out-of-band mutation and must trip the circuit breaker (ADR 0010) — the
 * reconciler reports, it never self-heals.
 */
export interface InternalReconciler {
  reconcileInternal(): Promise<DriftRow[]>;
}
