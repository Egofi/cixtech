import type { Attribution } from "@cixtech/attribution";
import { type LedgerService, depositFinalized } from "@cixtech/ledger";
import { Asset, IdempotencyKey, JournalEntryId, LedgerAccountKey } from "@cixtech/types";
import type { ChainDeposit } from "../chain-adapter.js";

/** Marks a credited deposit's address IN_USE — the pool lifecycle hook (ADR 0009). */
export interface AddressLifecycle {
  markInUse(chain: string, address: string): Promise<unknown>;
}

export type IngestStatus = "credited" | "duplicate" | "unmatched";

export interface IngestResult {
  status: IngestStatus;
  /** Deterministic idempotency key for the deposit, for logging/audit. */
  ref: string;
}

/**
 * Credits a CONFIRMED deposit to the ledger (ADR 0010). Attribution decides the
 * account; `depositFinalized` splits the fee; the store dedupes on the deposit's
 * idempotency key so a re-observed tx never double-credits. Finality is the
 * caller's precondition — this does not check confirmations.
 */
export class DepositIngestor {
  constructor(
    private readonly ledger: LedgerService,
    private readonly attribution: Attribution,
    /** Optional pool lifecycle: a credited deposit moves its address RESERVED → IN_USE. */
    private readonly lifecycle?: AddressLifecycle,
  ) {}

  async ingestConfirmed(d: ChainDeposit): Promise<IngestResult> {
    const ref = `${d.chain}:${d.txId}:${d.index}`;
    const attr = await this.attribution.resolve(d.chain, d.to);
    if (!attr) return { status: "unmatched", ref };

    const entry = depositFinalized({
      id: JournalEntryId(ref),
      idempotencyKey: IdempotencyKey(ref),
      asset: Asset(d.asset),
      amount: d.amountBaseUnits,
      feeBasisPoints: attr.feeBasisPoints,
      poolAddr: LedgerAccountKey(`pool_addr:${d.chain}:${attr.merchant}`),
      merchantAvailable: LedgerAccountKey(`merchant_available:${attr.tenant}:${attr.merchant}`),
      feeRevenue: LedgerAccountKey(`egofi_fee_revenue:${attr.tenant}`),
    });

    const { applied } = await this.ledger.post(entry);
    if (applied && this.lifecycle) {
      // Best-effort: the credit is committed; advancing the address state must not
      // undo it. A RESERVED→IN_USE miss is reconciled by the pool sweeper.
      await this.lifecycle.markInUse(d.chain, d.to).catch(() => {});
    }
    return { status: applied ? "credited" : "duplicate", ref };
  }
}
