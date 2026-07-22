import type { GatheredLeg, PoolGatherer } from "@cixtech/attribution";
import { type LedgerService, payoutSettled } from "@cixtech/ledger";
import { Asset, IdempotencyKey, JournalEntryId, LedgerAccountKey } from "@cixtech/types";
import { type AuthorizationSigner, transferCommitment } from "./authorization.js";
import type { PayoutBroadcaster } from "./broadcaster.js";
import type { PayoutJournal } from "./payout-journal.js";
import type { PayoutContext, PolicyEngine } from "./policy.js";

export interface PayoutParams {
  tenant: string;
  merchant: string;
  chain: string;
  asset: string;
  amountBaseUnits: bigint;
  destination: string;
  /** Caller-supplied dedupe key for the whole payout. */
  idempotencyKey: string;
  /** Identity that requested the payout (separation of duties, §7.4). */
  requester?: string;
  /** Distinct operator identities that have approved this intent (§7.4). */
  approvals?: readonly string[];
}

export interface PayoutLeg {
  address: string;
  txId: string;
  amountBaseUnits: bigint;
}

export interface PayoutResult {
  txId: string;
  status: "settled";
  /** The (primary) pool address the funds were sent from. */
  from: string;
  /** Present only when the payout was gathered across more than one pool address. */
  legs?: PayoutLeg[];
}

export interface PayoutServiceOptions {
  /**
   * Durable intent journal (recommended). With it a payout is crash-recoverable
   * and a retry never double-broadcasts: the intent is recorded before the send,
   * the tx id before the settle, and a resume picks up from the stored state.
   */
  journal?: PayoutJournal;
  /** Mints the authorization token bound to each transfer (§7); the broadcaster re-verifies it. */
  authorizer?: AuthorizationSigner;
  /** Authorization token lifetime. Default 5 minutes. */
  authTtlMs?: number;
}

const DEFAULT_AUTH_TTL_MS = 5 * 60_000;

/**
 * Orchestrates a payout end to end (build spec §16 flow): policy guard → gather
 * the merchant's funded pool addresses → lock the funds in the ledger (available →
 * pending) → broadcast on-chain → settle (pending → out of the pool). The ONLY
 * place money leaves custody.
 *
 * Crash-safety (the double-spend fix): every payout is a durable intent. It is
 * recorded `locked` before anything moves, its on-chain tx id is recorded
 * `broadcast` before the ledger settles, and a retry with the same idempotency key
 * RESUMES from the stored state instead of re-gathering and re-sending. Combined
 * with a broadcaster idempotent on the same key, a crash between "sent" and
 * "recorded" can never produce a second on-chain transfer.
 *
 * The from-address is CHOSEN here by gathering (ADR 0009), never supplied by the
 * caller; the broadcaster signs it with the pool-derived key (via the Signer).
 */
export class PayoutService {
  private readonly journal: PayoutJournal | undefined;
  private readonly authorizer: AuthorizationSigner | undefined;
  private readonly authTtlMs: number;

  constructor(
    private readonly ledger: LedgerService,
    private readonly policy: PolicyEngine,
    private readonly broadcaster: PayoutBroadcaster,
    private readonly gatherer: PoolGatherer,
    options: PayoutServiceOptions = {},
  ) {
    this.journal = options.journal;
    this.authorizer = options.authorizer;
    this.authTtlMs = options.authTtlMs ?? DEFAULT_AUTH_TTL_MS;
  }

  async payout(p: PayoutParams): Promise<PayoutResult> {
    const now = new Date();

    // 0. Record (or resume) the durable intent. createdAt anchors the time-lock.
    const intent = this.journal
      ? await this.journal.begin({
          idempotencyKey: p.idempotencyKey,
          tenant: p.tenant,
          merchant: p.merchant,
          chain: p.chain,
          asset: p.asset,
          amountBaseUnits: p.amountBaseUnits,
          destination: p.destination,
        })
      : null;

    // Idempotent replay: a fully-settled intent returns its recorded result.
    if (intent?.status === "settled" && intent.txId) {
      return { txId: intent.txId, status: "settled", from: intent.fromAddress ?? "" };
    }

    // Resume: the tx already broadcast but the ledger never settled → settle only.
    if (intent?.status === "broadcast" && intent.txId && intent.fromAddress) {
      await this.settle(p, intent.txId);
      await this.journal?.markSettled(p.idempotencyKey);
      return { txId: intent.txId, status: "settled", from: intent.fromAddress };
    }

    // 1. Guard — throws the specific §7 error (deny/approval/hold/delay) before
    //    anything moves. The time-lock anchor is the intent's first-seen time.
    const ctx: PayoutContext = {
      tenant: p.tenant,
      merchant: p.merchant,
      chain: p.chain,
      asset: p.asset,
      amountBaseUnits: p.amountBaseUnits,
      destination: p.destination,
      ...(p.requester !== undefined ? { requester: p.requester } : {}),
      ...(p.approvals !== undefined ? { approvals: p.approvals } : {}),
      requestedAt: intent?.createdAt ?? now,
    };
    await this.policy.check(ctx, now);

    // 2. Gather — one leg when a single address covers it, else consolidate across
    //    the merchant's pool addresses (ADR 0009 §6.3). Throws if truly short.
    const legs = await this.gatherer.gather(
      p.tenant,
      p.merchant,
      p.chain,
      p.asset,
      p.amountBaseUnits,
    );
    const primaryFrom = legs[0]?.address ?? "";
    await this.journal?.setFrom(p.idempotencyKey, primaryFrom);

    const asset = Asset(p.asset);
    const available = LedgerAccountKey(`merchant_available:${p.tenant}:${p.merchant}`);
    const pending = LedgerAccountKey(`merchant_pending_withdrawal:${p.tenant}:${p.merchant}`);

    // 3. Lock — reserves the funds (throws InsufficientFundsError if short).
    await this.ledger.lockPayout({
      id: JournalEntryId(`${p.idempotencyKey}:lock`),
      idempotencyKey: IdempotencyKey(`${p.idempotencyKey}:lock`),
      asset,
      amount: p.amountBaseUnits,
      merchantAvailable: available,
      merchantPendingWithdrawal: pending,
    });

    // 4. Broadcast each leg. Idempotent on a per-leg key: a crash before the tx id
    //    is recorded is safe because the broadcaster returns the same tx id.
    const sent: PayoutLeg[] = [];
    for (let i = 0; i < legs.length; i++) {
      const leg = legs[i] as GatheredLeg;
      const legKey = legs.length === 1 ? p.idempotencyKey : `${p.idempotencyKey}:${i}`;
      const authorization = this.authorizer?.mint(
        {
          intentId: legKey,
          tenant: p.tenant,
          merchant: p.merchant,
          chain: p.chain,
          asset: p.asset,
          amount: leg.amountBaseUnits.toString(),
          destination: p.destination,
          sighash: transferCommitment({
            intentId: legKey,
            chain: p.chain,
            asset: p.asset,
            amount: leg.amountBaseUnits.toString(),
            destination: p.destination,
            fromAddress: leg.address,
          }),
          approvals: p.approvals ?? [],
        },
        { now, ttlMs: this.authTtlMs },
      );
      const { txId } = await this.broadcaster.send({
        chain: p.chain,
        asset: p.asset,
        amountBaseUnits: leg.amountBaseUnits,
        fromAddress: leg.address,
        fromDerivationIndex: leg.derivationIndex,
        toAddress: p.destination,
        idempotencyKey: legKey,
        ...(authorization ? { authorization } : {}),
      });
      sent.push({ address: leg.address, txId, amountBaseUnits: leg.amountBaseUnits });
    }
    const primaryTxId = sent[0]?.txId ?? "";
    await this.journal?.markBroadcast(p.idempotencyKey, primaryTxId);

    // 5. Settle — funds leave the pool; the liability is discharged.
    await this.settle(p, primaryTxId);
    await this.journal?.markSettled(p.idempotencyKey);

    const result: PayoutResult = { txId: primaryTxId, status: "settled", from: primaryFrom };
    if (sent.length > 1) result.legs = sent;
    return result;
  }

  /** Discharge the earmarked liability and move the asset out of the pool (idempotent on the intent). */
  private async settle(p: PayoutParams, _txId: string): Promise<void> {
    const asset = Asset(p.asset);
    const pending = LedgerAccountKey(`merchant_pending_withdrawal:${p.tenant}:${p.merchant}`);
    const pool = LedgerAccountKey(`pool_addr:${p.chain}:${p.merchant}`);
    await this.ledger.post(
      payoutSettled({
        id: JournalEntryId(`settle:${p.idempotencyKey}`),
        idempotencyKey: IdempotencyKey(`settle:${p.idempotencyKey}`),
        asset,
        amount: p.amountBaseUnits,
        merchantPendingWithdrawal: pending,
        poolAddr: pool,
      }),
    );
  }
}
