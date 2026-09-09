import type { Asset, DriftRow, LedgerAccountKey } from "@/types";

export interface InternalReconciler {
  reconcileInternal(): Promise<DriftRow[]>;
}
