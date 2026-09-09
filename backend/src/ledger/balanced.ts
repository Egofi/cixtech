import { InvalidPostingError, UnbalancedEntryError } from "@/common";
import type { JournalEntry, Posting } from "@/types";

export function nettedByAsset(postings: readonly Posting[]): Map<string, bigint> {
  const net = new Map<string, bigint>();
  for (const p of postings) {
    if (p.amount <= 0n) {
      throw new InvalidPostingError(`Posting amount must be positive, got ${p.amount}`);
    }
    const signed = p.direction === "DEBIT" ? p.amount : -p.amount;
    net.set(p.asset, (net.get(p.asset) ?? 0n) + signed);
  }
  return net;
}

export function isBalanced(entry: JournalEntry): boolean {
  for (const v of nettedByAsset(entry.postings).values()) {
    if (v !== 0n) return false;
  }
  return true;
}

export function assertBalanced(entry: JournalEntry): void {
  if (entry.postings.length === 0) {
    throw new UnbalancedEntryError(`Journal entry ${entry.id} has no postings`);
  }
  if (!isBalanced(entry)) {
    throw new UnbalancedEntryError(
      `Journal entry ${entry.id} (${entry.kind}) does not sum to zero per asset`,
    );
  }
}
