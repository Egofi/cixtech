import type { Asset, LedgerAccountKey } from "@cixtech/types";
import { normalBalance } from "./account-classify.js";
import { assertBalanced } from "./balanced.js";
import type { JournalEntry } from "./entry.js";
import type { LedgerStore } from "./ledger.port.js";
import { type PayoutLockedInput, payoutLocked } from "./posting-flows.js";
import { type AssetSolvency, solvencyDrift } from "./solvency.js";

/** A payout was requested for more than the merchant's available balance. */
export class InsufficientFundsError extends Error {}

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

  /** Balance on the account's own normal side (positive magnitude), e.g. funds a merchant can withdraw. */
  async availableBalance(account: LedgerAccountKey, asset: Asset): Promise<bigint> {
    return normalBalance(account, await this.store.balance(account, asset));
  }

  /**
   * Lock a payout — the first money-movement GUARD. Rejects a payout larger than
   * the merchant's available balance, so `merchant_available` can never be driven
   * negative (property 8). Passing the guard, it posts the reclassification entry.
   */
  async lockPayout(input: PayoutLockedInput): Promise<{ applied: boolean }> {
    const available = await this.availableBalance(input.merchantAvailable, input.asset);
    if (input.amount > available) {
      throw new InsufficientFundsError(
        `Payout of ${input.amount} exceeds available ${available} for ${input.merchantAvailable}`,
      );
    }
    return this.post(payoutLocked(input));
  }

  /** Assets breaching Σ ASSET ≥ Σ LIABILITY. Empty == solvent. Callers freeze on non-empty. */
  async checkSolvency(assets: Iterable<string>): Promise<AssetSolvency[]> {
    return solvencyDrift(await this.store.totalsByType(), assets);
  }
}
