import type { Attribution } from "@cixtech/attribution";
import {
  type LedgerService,
  UnknownEntryError,
  depositFinalized,
  depositQuarantined,
} from "@cixtech/ledger";
import { Asset, IdempotencyKey, JournalEntryId, LedgerAccountKey } from "@cixtech/types";
import type { ChainDeposit } from "../chain-adapter.js";

/** Marks a credited deposit's address IN_USE — the pool lifecycle hook (ADR 0009). */
export interface AddressLifecycle {
  markInUse(chain: string, address: string): Promise<unknown>;
}

/**
 * KYT / sanctions screen for INBOUND deposits (build spec §14). Deposits are
 * unilateral — anyone can send us funds — so a flagged deposit must NOT be credited
 * to the merchant; it is quarantined in `compliance_suspense` pending a decision.
 * `screen` returns `clear` to credit normally or `blocked` to quarantine. Fail
 * closed: a screener that throws is treated as inconclusive by the caller's policy
 * (here, the ingestor propagates the error so the deposit is retried, never
 * silently credited).
 */
export interface DepositScreener {
  screen(deposit: ChainDeposit): Promise<"clear" | "blocked"> | "clear" | "blocked";
}

export type IngestStatus = "credited" | "quarantined" | "duplicate" | "unmatched";

export type ReverseStatus = "reversed" | "not-found";

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
    /** Optional KYT/sanctions screen (§14). Absent = credit without screening (dev/test only). */
    private readonly screener?: DepositScreener,
  ) {}

  async ingestConfirmed(d: ChainDeposit): Promise<IngestResult> {
    const ref = `${d.chain}:${d.txId}:${d.index}`;
    const attr = await this.attribution.resolve(d.chain, d.to);
    if (!attr) return { status: "unmatched", ref };

    const poolAddr = LedgerAccountKey(`pool_addr:${d.chain}:${attr.merchant}`);

    // KYT / sanctions on detection (§14). A flagged deposit is HELD in
    // compliance_suspense — the value is recorded (provably held) but never
    // credited to the merchant until compliance releases or returns it.
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
      // Still advance the address state — the funds physically landed in it.
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
      // Best-effort: the credit is committed; advancing the address state must not
      // undo it. A RESERVED→IN_USE miss is reconciled by the pool sweeper.
      await this.lifecycle.markInUse(d.chain, d.to).catch(() => {});
    }
    return { status: applied ? "credited" : "duplicate", ref };
  }

  /**
   * Reverse a previously-credited deposit that reorged out AFTER finality (build
   * spec §9 — the rare deep-reorg case the finality depth was meant to prevent).
   * Posts a compensating reversal of the exact original entry, returning every
   * touched balance to its pre-credit value. Idempotent on `reverse:{ref}`, so a
   * redelivered reorg signal reverses exactly once; a ref that was never credited
   * (e.g. it was `unmatched`) is a no-op, not an error.
   */
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
