import type { Asset, LedgerAccountKey } from "@cixtech/types";
import { assertBalanced } from "./balanced.js";
import type { JournalEntry } from "./entry.js";
import type { LedgerStore } from "./ledger.port.js";
import { type AssetSolvency, solvencyDrift } from "./solvency.js";

/**
 * The only path that writes to the ledger. Enforces the balance rule before any
 * store call, so an unbalanced entry can never be persisted (property 1).
 */
export class LedgerService {
  constructor(private readonly store: LedgerStore) {}

  async post(entry: JournalEntry): Promise<{ applied: boolean }> {
    assertBalanced(entry);
    return this.store.append(entry);
  }

  getBalance(account: LedgerAccountKey, asset: Asset): Promise<bigint> {
    return this.store.balance(account, asset);
  }

  /** Assets breaching Σ ASSET ≥ Σ LIABILITY. Empty == solvent. Callers freeze on non-empty. */
  async checkSolvency(assets: Iterable<string>): Promise<AssetSolvency[]> {
    return solvencyDrift(await this.store.totalsByType(), assets);
  }
}
