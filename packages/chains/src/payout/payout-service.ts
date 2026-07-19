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
  /** The pool/treasury address the funds are sent from. */
  fromAddress: string;
  /** Caller-supplied dedupe key for the whole payout. */
  idempotencyKey: string;
}

export interface PayoutResult {
  txId: string;
  status: "settled";
}

/**
 * Orchestrates a payout end to end (build spec §16 flow): policy guard → lock the
 * funds in the ledger (available → pending) → broadcast on-chain → settle
 * (pending → out of the pool). The ONLY place money leaves custody. Signing lives
 * inside the broadcaster, after the policy guard has already said yes.
 */
export class PayoutService {
  constructor(
    private readonly ledger: LedgerService,
    private readonly policy: PolicyEngine,
    private readonly broadcaster: PayoutBroadcaster,
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

    const asset = Asset(p.asset);
    const available = LedgerAccountKey(`merchant_available:${p.tenant}:${p.merchant}`);
    const pending = LedgerAccountKey(`merchant_pending_withdrawal:${p.tenant}:${p.merchant}`);
    const pool = LedgerAccountKey(`pool_addr:${p.chain}:${p.merchant}`);

    // 2. Lock — reserves the funds (throws InsufficientFundsError if short).
    await this.ledger.lockPayout({
      id: JournalEntryId(`${p.idempotencyKey}:lock`),
      idempotencyKey: IdempotencyKey(`${p.idempotencyKey}:lock`),
      asset,
      amount: p.amountBaseUnits,
      merchantAvailable: available,
      merchantPendingWithdrawal: pending,
    });

    // 3. Broadcast — signs and sends. (Failure here leaves funds locked in
    //    pending for a recovery job; robust retry/cancel is a follow-up.)
    const { txId } = await this.broadcaster.send({
      chain: p.chain,
      asset: p.asset,
      amountBaseUnits: p.amountBaseUnits,
      fromAddress: p.fromAddress,
      toAddress: p.destination,
    });

    // 4. Settle — funds leave the pool; the liability is discharged.
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

    return { txId, status: "settled" };
  }
}
