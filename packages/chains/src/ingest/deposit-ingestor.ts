import { type LedgerService, depositFinalized } from "@cixtech/ledger";
import { Asset, IdempotencyKey, JournalEntryId, LedgerAccountKey } from "@cixtech/types";
import type { ChainDeposit } from "../chain-adapter.js";

/** Who owns a deposit address, and the fee that applies. */
export interface AttributionEntry {
  tenant: string;
  merchant: string;
  feeBasisPoints: number;
}

/**
 * Resolves an on-chain deposit address to its owning account. This is a
 * placeholder for the pooled-address attribution layer (ADR 0009); the money-in
 * slice uses a simple address book so the end-to-end flow is exercised now.
 */
export interface Attribution {
  resolve(chain: string, address: string): Promise<AttributionEntry | null>;
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
    return { status: applied ? "credited" : "duplicate", ref };
  }
}
