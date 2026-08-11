import type { GatherStrategyRegistry, GatheredLeg, PoolGatherer } from "@cixtech/attribution";
import { type LedgerService, feeSwept, payoutSettled } from "@cixtech/ledger";
import { Asset, IdempotencyKey, JournalEntryId, LedgerAccountKey } from "@cixtech/types";
import type { FeeSweepPlanner } from "../treasury/fee-sweep-planner.js";
import { type ApprovalStore, WithdrawalNotFoundError } from "./approval-store.js";
import { type AuthorizationSigner, transferCommitment } from "./authorization.js";
import type { PayoutBroadcaster } from "./broadcaster.js";
import type { PayoutIntent, PayoutJournal } from "./payout-journal.js";
import { ApprovalRequiredError, type PayoutContext, type PolicyEngine } from "./policy.js";

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
  /**
   * Durable approvals (§7.4). Present = the service can collect approvals against a
   * held intent and resume it once the quorum is met.
   */
  approvals?: ApprovalStore;
  /** How many distinct approvals a held payout needs. Mirrors the policy config. */
  approvalsRequired?: number;
  /**
   * Collects the platform's accrued fee in the same pass as the payout (§6.3).
   *
   * The engine is already sending a transaction out of these addresses; the fee
   * rides along instead of paying for a gather of its own. Absent = payouts
   * behave exactly as before, so this is additive.
   */
  feeSweep?: {
    planner: FeeSweepPlanner;
    /** Where the platform's share goes, per chain. Absent for a chain = no sweep there. */
    treasuryAddressFor: (chain: string) => string | undefined;
  };
  /**
   * Gather strategies (ADR 0011). Each leg is prepared by the strategy its address
   * was MINTED under — which is what provisions native gas before an ERC-20 /
   * TRC-20 transfer. Absent = no preparation, which only works on chains whose
   * fee comes out of the transfer itself (UTXO).
   */
  gatherStrategies?: GatherStrategyRegistry;
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
  private readonly gatherStrategies: GatherStrategyRegistry | undefined;
  private readonly approvals: ApprovalStore | undefined;
  private readonly approvalsRequired: number;
  private readonly feeSweep: PayoutServiceOptions["feeSweep"];

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
    this.gatherStrategies = options.gatherStrategies;
    this.approvals = options.approvals;
    this.approvalsRequired = options.approvalsRequired ?? 0;
    this.feeSweep = options.feeSweep;
  }

  /** Look up a recorded intent by its public id — what the approve endpoint addresses. */
  async findIntent(tenant: string, idempotencyKey: string): Promise<PayoutIntent | null> {
    return (await this.journal?.load(idempotencyKey)) ?? null;
  }

  /**
   * Record one approval against a held payout and, once the quorum is met, resume
   * it (build spec §7.4, §16).
   *
   * Resuming reuses the intent's ORIGINAL idempotency key, so the payout continues
   * the recorded intent instead of starting a second one — the approval path
   * inherits the same double-spend safety as a retry.
   */
  async approve(input: {
    tenant: string;
    withdrawalId: string;
    approver: string;
  }): Promise<
    | { status: "settled"; txId: string; from: string; approvals: string[] }
    | { status: "pending"; needed: number; approvals: string[] }
  > {
    if (!this.journal || !this.approvals) {
      throw new Error("Approvals need a payout journal and an approval store");
    }
    const intent = await this.journal.loadById(input.tenant, input.withdrawalId);
    if (!intent) {
      throw new WithdrawalNotFoundError(`No withdrawal ${input.withdrawalId}`, {
        context: { withdrawalId: input.withdrawalId },
        exposable: true,
      });
    }
    if (intent.status === "settled") {
      return {
        status: "settled",
        txId: intent.txId ?? "",
        from: intent.fromAddress ?? "",
        approvals: await this.approvals.approversFor(intent.idempotencyKey),
      };
    }

    // Throws on self-approval; a repeat from the same approver is a no-op.
    await this.approvals.approve({
      tenant: input.tenant,
      intentKey: intent.idempotencyKey,
      approver: input.approver,
      requestedBy: intent.requestedBy,
    });
    const approvals = await this.approvals.approversFor(intent.idempotencyKey);

    try {
      const result = await this.payout({
        tenant: intent.tenant,
        merchant: intent.merchant,
        chain: intent.chain,
        asset: intent.asset,
        amountBaseUnits: intent.amountBaseUnits,
        destination: intent.destination,
        idempotencyKey: intent.idempotencyKey,
        ...(intent.requestedBy ? { requester: intent.requestedBy } : {}),
        approvals,
      });
      return { status: "settled", txId: result.txId, from: result.from, approvals };
    } catch (err) {
      // Still short of quorum (or still time-locked) — the approval is recorded and
      // the intent stays exactly where it was. Anything else is a real failure.
      if (err instanceof ApprovalRequiredError) {
        return { status: "pending", needed: this.approvalsRequired, approvals };
      }
      throw err;
    }
  }

  async payout(p: PayoutParams): Promise<PayoutResult> {
    const now = new Date();

    // 0. Record (or resume) the durable intent. createdAt anchors the time-lock.
    const intent = this.journal
      ? await this.journal.begin({
          idempotencyKey: p.idempotencyKey,
          ...(p.requester !== undefined ? { requestedBy: p.requester } : {}),
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

      // 4a. Prepare the leg under the strategy THIS ADDRESS WAS MINTED UNDER —
      //     `leg.gatherStrategy`, never the current global toggle (ADR 0011).
      //     Dispatching on the toggle would build a transaction the address cannot
      //     execute and strand its balance. On EVM/Tron this is where the pool
      //     address gets the native gas an ERC-20/TRC-20 transfer needs; without
      //     it the broadcast below fails for insufficient gas.
      if (this.gatherStrategies) {
        await this.gatherStrategies.forAddress(leg.gatherStrategy).prepare({
          chain: p.chain,
          address: leg.address,
          derivationIndex: leg.derivationIndex,
          asset: p.asset,
          amountBaseUnits: leg.amountBaseUnits,
          idempotencyKey: legKey,
        });
      }

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

    // 6. Take the platform's accrued fee out of the same addresses, now that the
    //    merchant's legs are sent and their share of each balance is spoken for.
    await this.sweepFee(p, legs);

    const result: PayoutResult = { txId: primaryTxId, status: "settled", from: primaryFrom };
    if (sent.length > 1) result.legs = sent;
    return result;
  }

  /**
   * Collect the platform's accrued fee from the addresses this payout just used.
   *
   * Deliberately AFTER the merchant is paid and settled: the merchant's money is
   * the obligation, the platform's fee is not, so a failure here must never be
   * able to hold up a withdrawal. Any leg that fails is simply left for the next
   * payout or a manual settle — the claim is recomputed from the ledger every
   * time, so nothing is lost by deferring it.
   *
   * The ledger entry is posted per leg, only once its transfer has been sent,
   * which is what keeps `pool_addr` in step with the chain. Posting first would
   * manufacture exactly the drift the external reconciler treats as theft.
   */
  private async sweepFee(p: PayoutParams, merchantLegs: GatheredLeg[]): Promise<void> {
    if (!this.feeSweep) return;
    const treasuryAddress = this.feeSweep.treasuryAddressFor(p.chain);
    if (!treasuryAddress) return;

    // What the merchant's legs already committed on each address, so the fee
    // plan cannot try to spend the same coins twice.
    const reserved = new Map<string, bigint>();
    for (const leg of merchantLegs) {
      reserved.set(leg.address, (reserved.get(leg.address) ?? 0n) + leg.amountBaseUnits);
    }

    let plan: Awaited<ReturnType<FeeSweepPlanner["plan"]>>;
    try {
      plan = await this.feeSweep.planner.plan(p.tenant, p.merchant, p.chain, p.asset, reserved);
    } catch {
      return; // The payout stands; the fee waits for the next opportunity.
    }
    if (plan.legs.length === 0) return;

    const asset = Asset(p.asset);
    const treasury = LedgerAccountKey(`treasury:${p.chain}`);
    const pool = LedgerAccountKey(`pool_addr:${p.chain}:${p.merchant}`);

    for (let i = 0; i < plan.legs.length; i++) {
      const leg = plan.legs[i] as (typeof plan.legs)[number];
      // Derived from the payout key, never a timestamp: a retry must land on the
      // same key and be absorbed, not post a second entry.
      const legKey = `${p.idempotencyKey}:fee:${i}`;
      try {
        // An address used for BOTH a merchant leg and a fee leg has to pay for
        // two transfers, and `prepare` only guarantees one. What covers the
        // second is the gas funder topping up to `requirement × topUpMultiple`
        // (3×) rather than to the requirement exactly — so this call finds the
        // address already funded and provisions nothing. That multiple is
        // load-bearing here, not a comfort margin: drop it to 1 and every fee
        // leg on a shared address fails for insufficient gas.
        if (this.gatherStrategies) {
          await this.gatherStrategies.forAddress(leg.gatherStrategy).prepare({
            chain: p.chain,
            address: leg.address,
            derivationIndex: leg.derivationIndex,
            asset: p.asset,
            amountBaseUnits: leg.amountBaseUnits,
            idempotencyKey: legKey,
          });
        }
        await this.broadcaster.send({
          chain: p.chain,
          asset: p.asset,
          amountBaseUnits: leg.amountBaseUnits,
          fromAddress: leg.address,
          fromDerivationIndex: leg.derivationIndex,
          toAddress: treasuryAddress,
          idempotencyKey: legKey,
        });
        await this.ledger.post(
          feeSwept({
            id: JournalEntryId(legKey),
            idempotencyKey: IdempotencyKey(legKey),
            asset,
            amount: leg.amountBaseUnits,
            poolAddr: pool,
            treasury,
          }),
        );
      } catch {
        // One address failing (gas, RPC) must not abort the rest, and must not
        // fail the payout that already succeeded.
      }
    }
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
