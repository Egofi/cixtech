import { AppError } from "@/errors";
import type { Asset, IdempotencyKey, JournalEntryId, LedgerAccountKey } from "@/types";
import { normalBalance } from "./account-classify.js";
import { assertBalanced } from "./balanced.js";
import { type JournalEntry, flip } from "./entry.js";
import type { LedgerStore } from "./ledger.port.js";
import { type PayoutLockedInput, payoutLocked } from "./posting-flows.js";
import { type AssetSolvency, solvencyDrift } from "./solvency.js";

/** A payout was requested for more than the merchant's available balance. */
export class InsufficientFundsError extends AppError {
  readonly code = "LEDGER_INSUFFICIENT_FUNDS";
}

/** A reversal was requested for a journal entry that was never posted. */
export class UnknownEntryError extends AppError {
  readonly code = "LEDGER_UNKNOWN_ENTRY";
}

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
        {
          context: {
            account: String(input.merchantAvailable),
            asset: String(input.asset),
            requested: input.amount.toString(),
            available: available.toString(),
          },
        },
      );
    }
    return this.post(payoutLocked(input));
  }

  /**
   * Post a compensating reversal of a previously-applied entry, by its id (reorg
   * safety, ADR 0010 / build spec §9). Loads the original postings and flips every
   * direction, so every touched balance returns to its exact pre-entry value. The
   * reversal carries its own idempotency key, so a redelivered reorg signal
   * reverses exactly once. Throws if the original id was never posted — a reversal
   * must never invent postings for an entry that did not happen.
   */
  async reverseByRef(
    originalId: JournalEntryId,
    newId: JournalEntryId,
    newKey: IdempotencyKey,
    occurredAt: Date = new Date(),
  ): Promise<{ applied: boolean }> {
    const original = await this.store.entryPostings(originalId);
    if (original.length === 0) {
      throw new UnknownEntryError(`Cannot reverse unknown journal entry ${String(originalId)}`, {
        context: { originalId: String(originalId) },
      });
    }
    const reversed: JournalEntry = {
      id: newId,
      idempotencyKey: newKey,
      kind: "reverse",
      postings: original.map((p) => ({ ...p, direction: flip(p.direction) })),
      occurredAt,
    };
    return this.post(reversed);
  }

  /** Assets breaching Σ ASSET ≥ Σ LIABILITY. Empty == solvent. Callers freeze on non-empty. */
  async checkSolvency(assets: Iterable<string>): Promise<AssetSolvency[]> {
    return solvencyDrift(await this.store.totalsByType(), assets);
  }

  /**
   * Fail-CLOSED solvency probe for the money-out path (build spec §7.7): true iff
   * the asset currently satisfies Σ ASSET ≥ Σ LIABILITY. A caller that cannot
   * prove solvency must refuse the payout.
   */
  async isSolvent(asset: string): Promise<boolean> {
    return (await this.checkSolvency([asset])).length === 0;
  }
}
