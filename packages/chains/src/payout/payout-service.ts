import type { PoolGatherer } from "@cixtech/attribution";
import { type LedgerService, payoutSettled } from "@cixtech/ledger";
import { Asset, IdempotencyKey, JournalEntryId, LedgerAccountKey } from "@cixtech/types";
import type { PayoutBroadcaster } from "./broadcaster.js";
import type { PolicyEngine } from "./policy.js";

export interface PayoutParams {
  tenant: string;
  merchant: string;
  chain: string;
  asset: string;
  amountBaseUnits: bigint;
  destination: string;
  /** Caller-supplied dedupe key for the whole payout. */
  idempotencyKey: string;
}

export interface PayoutResult {
  txId: string;
  status: "settled";
  /** The pool address the funds were sent from (chosen by gathering). */
  from: string;
}

/**
 * Orchestrates a payout end to end (build spec §16 flow): policy guard → gather
 * the funding pool address → lock the funds in the ledger (available → pending) →
 * broadcast on-chain → settle (pending → out of the pool). The ONLY place money
 * leaves custody. The from-address is CHOSEN here by gathering the merchant's
 * funded pool addresses (ADR 0009), never supplied by the caller; the broadcaster
 * signs it with the pool-derived key (via the Signer — MPC later, ADR 0007).
 */
export class PayoutService {
  constructor(
    private readonly ledger: LedgerService,
    private readonly policy: PolicyEngine,
    private readonly broadcaster: PayoutBroadcaster,
    private readonly gatherer: PoolGatherer,
  ) {}

  async payout(p: PayoutParams): Promise<PayoutResult> {
    // 1. Guard — throws PolicyDeniedError before anything moves.
    this.policy.check({
      tenant: p.tenant,
      merchant: p.merchant,
      chain: p.chain,
      asset: p.asset,
      amountBaseUnits: p.amountBaseUnits,
      destination: p.destination,
    });

    // 2. Gather — choose a funded pool address to pay from (throws if none covers it).
    const source = await this.gatherer.gatherSingle(
      p.tenant,
      p.merchant,
      p.chain,
      p.asset,
      p.amountBaseUnits,
    );

    const asset = Asset(p.asset);
    const available = LedgerAccountKey(`merchant_available:${p.tenant}:${p.merchant}`);
    const pending = LedgerAccountKey(`merchant_pending_withdrawal:${p.tenant}:${p.merchant}`);
    const pool = LedgerAccountKey(`pool_addr:${p.chain}:${p.merchant}`);

    // 3. Lock — reserves the funds (throws InsufficientFundsError if short).
    await this.ledger.lockPayout({
      id: JournalEntryId(`${p.idempotencyKey}:lock`),
      idempotencyKey: IdempotencyKey(`${p.idempotencyKey}:lock`),
      asset,
      amount: p.amountBaseUnits,
      merchantAvailable: available,
      merchantPendingWithdrawal: pending,
    });

    // 4. Broadcast — signs from the gathered address's pool-derived key and sends.
    //    (Failure here leaves funds locked in pending for a recovery job.)
    const { txId } = await this.broadcaster.send({
      chain: p.chain,
      asset: p.asset,
      amountBaseUnits: p.amountBaseUnits,
      fromAddress: source.address,
      fromDerivationIndex: source.derivationIndex,
      toAddress: p.destination,
    });

    // 5. Settle — funds leave the pool; the liability is discharged.
    await this.ledger.post(
      payoutSettled({
        id: JournalEntryId(`settle:${txId}`),
        idempotencyKey: IdempotencyKey(`settle:${txId}`),
        asset,
        amount: p.amountBaseUnits,
        merchantPendingWithdrawal: pending,
        poolAddr: pool,
      }),
    );

    return { txId, status: "settled", from: source.address };
  }
}
