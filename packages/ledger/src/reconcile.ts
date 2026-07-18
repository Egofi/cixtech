import type { Asset, LedgerAccountKey } from "@cixtech/types";
import type { LedgerStore } from "./ledger.port.js";

/**
 * Internal reconciler: for every account+asset, the materialized `balance()` must
 * equal the signed sum of `postingsFor()`. Any drift means the ledger disagrees
 * with its own history — a bug or tampering. Reports drift; never self-heals.
 *
 * TODO(step1): implement + property 12 (must catch an out-of-band mutation, i.e.
 * pass mutation testing rather than rubber-stamping).
 */
export interface DriftRow {
  account: LedgerAccountKey;
  asset: Asset;
  materialized: bigint;
  fromHistory: bigint;
}

export async function reconcileInternal(_store: LedgerStore): Promise<DriftRow[]> {
  throw new Error("TODO(step1): implement internal reconciler (balance == Σ postings)");
}
