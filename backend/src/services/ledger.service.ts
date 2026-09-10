import { InsufficientFundsError, UnknownEntryError } from "@/common";
import { normalBalance } from "@/ledger/account-classify.js";
import { assertBalanced } from "@/ledger/balanced.js";
import { flip } from "@/ledger/entry.js";
import type { LedgerStore } from "@/ledger/ledger.port.js";
import { payoutLocked } from "@/ledger/posting-flows.js";
import { solvencyDrift } from "@/ledger/solvency.js";
import type {
  Asset,
  AssetSolvency,
  IdempotencyKey,
  JournalEntry,
  JournalEntryId,
  LedgerAccountKey,
  PayoutLockedInput,
} from "@/types";

export class LedgerService {
  constructor(private readonly store: LedgerStore) {}

  async post(entry: JournalEntry): Promise<{ applied: boolean }> {
    assertBalanced(entry);
    return this.store.append(entry);
  }

  getBalance(account: LedgerAccountKey, asset: Asset): Promise<bigint> {
    return this.store.balance(account, asset);
  }

  async availableBalance(account: LedgerAccountKey, asset: Asset): Promise<bigint> {
    return normalBalance(account, await this.store.balance(account, asset));
  }

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

  async checkSolvency(assets: Iterable<string>): Promise<AssetSolvency[]> {
    return solvencyDrift(await this.store.totalsByType(), assets);
  }

  async isSolvent(asset: string): Promise<boolean> {
    return (await this.checkSolvency([asset])).length === 0;
  }
}
