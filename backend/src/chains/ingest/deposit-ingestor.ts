import type { Attribution } from "@/attribution";
import { UnknownEntryError } from "@/common";
import { depositFinalized, depositQuarantined } from "@/ledger";
import type { LedgerService } from "@/services";
import {
  Asset,
  type ChainDeposit,
  IdempotencyKey,
  type IngestResult,
  JournalEntryId,
  LedgerAccountKey,
  type ReverseStatus,
} from "@/types";

export interface AddressLifecycle {
  markInUse(chain: string, address: string): Promise<unknown>;
  cool(chain: string, address: string): Promise<unknown>;
}

export interface DepositScreener {
  screen(deposit: ChainDeposit): Promise<"clear" | "blocked"> | "clear" | "blocked";
}

export class DepositIngestor {
  constructor(
    private readonly ledger: LedgerService,
    private readonly attribution: Attribution,

    private readonly lifecycle?: AddressLifecycle,

    private readonly screener?: DepositScreener,
  ) {}

  async ingestConfirmed(d: ChainDeposit): Promise<IngestResult> {
    const ref = `${d.chain}:${d.txId}:${d.index}`;
    const attr = await this.attribution.resolve(d.chain, d.to);
    if (!attr) return { status: "unmatched", ref };

    const poolAddr = LedgerAccountKey(`pool_addr:${d.chain}:${attr.merchant}`);

    if (this.screener && (await this.screener.screen(d)) === "blocked") {
      const { applied } = await this.ledger.post(
        depositQuarantined({
          id: JournalEntryId(ref),
          idempotencyKey: IdempotencyKey(ref),
          asset: Asset(d.asset),
          amount: d.amountBaseUnits,
          poolAddr,
          complianceSuspense: LedgerAccountKey(`compliance_suspense:${attr.tenant}`),
        }),
      );

      if (applied && this.lifecycle) await this.lifecycle.markInUse(d.chain, d.to).catch(() => {});
      return { status: applied ? "quarantined" : "duplicate", ref };
    }

    const entry = depositFinalized({
      id: JournalEntryId(ref),
      idempotencyKey: IdempotencyKey(ref),
      asset: Asset(d.asset),
      amount: d.amountBaseUnits,
      feeBasisPoints: attr.feeBasisPoints,
      poolAddr,
      merchantAvailable: LedgerAccountKey(`merchant_available:${attr.tenant}:${attr.merchant}`),
      feeRevenue: LedgerAccountKey(`egofi_fee_revenue:${attr.tenant}`),
    });

    const { applied } = await this.ledger.post(entry);
    if (applied && this.lifecycle) {
      await this.lifecycle
        .markInUse(d.chain, d.to)
        .then(() => this.lifecycle?.cool(d.chain, d.to))
        .catch(() => {});
    }
    return { status: applied ? "credited" : "duplicate", ref };
  }

  async reverseCredit(d: ChainDeposit): Promise<{ status: ReverseStatus; ref: string }> {
    const ref = `${d.chain}:${d.txId}:${d.index}`;
    try {
      await this.ledger.reverseByRef(
        JournalEntryId(ref),
        JournalEntryId(`reverse:${ref}`),
        IdempotencyKey(`reverse:${ref}`),
      );
      return { status: "reversed", ref };
    } catch (err) {
      if (err instanceof UnknownEntryError) return { status: "not-found", ref };
      throw err;
    }
  }
}
