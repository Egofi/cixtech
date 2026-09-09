import type { GatherLease, PoolGatherer } from "@/attribution";
import type { GatherStrategyRegistry } from "@/attribution";
import type { FeeSweepPlanner } from "@/chains/treasury/fee-sweep-planner.js";
import { ApprovalRequiredError, GatherBusyError, WithdrawalNotFoundError } from "@/common";
import { feeSwept, payoutSettled } from "@/ledger";
import type { LedgerService } from "@/services";
import type { ApprovalStore } from "@/stores";
import {
  Asset,
  type GatheredLeg,
  IdempotencyKey,
  JournalEntryId,
  LedgerAccountKey,
  type PayoutContext,
  type PayoutIntent,
  type PayoutLeg,
  type PayoutParams,
  type PayoutResult,
} from "@/types";

import { type AuthorizationSigner, transferCommitment } from "@/chains/payout/authorization.js";
import type { PayoutBroadcaster } from "@/chains/payout/broadcaster.js";
import type { PayoutJournal } from "@/chains/payout/payout-journal.js";
import type { PolicyEngine } from "@/chains/payout/policy.js";

export interface PayoutServiceOptions {
  journal?: PayoutJournal;

  authorizer?: AuthorizationSigner;

  authTtlMs?: number;

  approvals?: ApprovalStore;

  approvalsRequired?: number;

  feeSweep?: {
    planner: FeeSweepPlanner;

    treasuryAddressFor: (chain: string) => string | undefined;
  };

  gatherLease?: GatherLease;

  gatherStrategies?: GatherStrategyRegistry;
}

const DEFAULT_AUTH_TTL_MS = 5 * 60_000;

export class PayoutService {
  private readonly journal: PayoutJournal | undefined;
  private readonly authorizer: AuthorizationSigner | undefined;
  private readonly authTtlMs: number;
  private readonly gatherStrategies: GatherStrategyRegistry | undefined;
  private readonly approvals: ApprovalStore | undefined;
  private readonly approvalsRequired: number;
  private readonly feeSweep: PayoutServiceOptions["feeSweep"];
  private readonly gatherLease: GatherLease | undefined;

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
    this.gatherLease = options.gatherLease;
  }

  async findIntent(tenant: string, idempotencyKey: string): Promise<PayoutIntent | null> {
    return (await this.journal?.load(idempotencyKey)) ?? null;
  }

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
      if (err instanceof ApprovalRequiredError) {
        return { status: "pending", needed: this.approvalsRequired, approvals };
      }
      throw err;
    }
  }

  async payout(p: PayoutParams): Promise<PayoutResult> {
    const now = new Date();

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

    if (intent?.status === "settled" && intent.txId) {
      return { txId: intent.txId, status: "settled", from: intent.fromAddress ?? "" };
    }

    if (intent?.status === "broadcast" && intent.txId && intent.fromAddress) {
      await this.settle(p, intent.txId);
      await this.journal?.markSettled(p.idempotencyKey);
      return { txId: intent.txId, status: "settled", from: intent.fromAddress };
    }

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

    const leaseHolder = p.idempotencyKey;
    const heldLease = this.gatherLease
      ? await this.gatherLease.acquire(p.tenant, p.merchant, p.chain, leaseHolder)
      : true;
    if (!heldLease) {
      throw new GatherBusyError(
        `Another operation is already spending ${p.merchant}'s ${p.chain} pool addresses. Retry shortly.`,
      );
    }
    try {
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

      await this.ledger.lockPayout({
        id: JournalEntryId(`${p.idempotencyKey}:lock`),
        idempotencyKey: IdempotencyKey(`${p.idempotencyKey}:lock`),
        asset,
        amount: p.amountBaseUnits,
        merchantAvailable: available,
        merchantPendingWithdrawal: pending,
      });

      const sent: PayoutLeg[] = [];
      for (let i = 0; i < legs.length; i++) {
        const leg = legs[i] as GatheredLeg;
        const legKey = legs.length === 1 ? p.idempotencyKey : `${p.idempotencyKey}:${i}`;

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

      await this.settle(p, primaryTxId);
      await this.journal?.markSettled(p.idempotencyKey);

      await this.sweepFee(p, legs);

      const result: PayoutResult = { txId: primaryTxId, status: "settled", from: primaryFrom };
      if (sent.length > 1) result.legs = sent;
      return result;
    } finally {
      await this.gatherLease?.release(p.tenant, p.merchant, p.chain, leaseHolder);
    }
  }

  private async sweepFee(p: PayoutParams, merchantLegs: GatheredLeg[]): Promise<void> {
    if (!this.feeSweep) return;
    const treasuryAddress = this.feeSweep.treasuryAddressFor(p.chain);
    if (!treasuryAddress) return;

    const reserved = new Map<string, bigint>();
    for (const leg of merchantLegs) {
      reserved.set(leg.address, (reserved.get(leg.address) ?? 0n) + leg.amountBaseUnits);
    }

    let plan: Awaited<ReturnType<FeeSweepPlanner["plan"]>>;
    try {
      plan = await this.feeSweep.planner.plan(p.tenant, p.merchant, p.chain, p.asset, reserved);
    } catch {
      return;
    }
    if (plan.legs.length === 0) return;

    const asset = Asset(p.asset);
    const treasury = LedgerAccountKey(`treasury:${p.chain}`);
    const pool = LedgerAccountKey(`pool_addr:${p.chain}:${p.merchant}`);

    for (let i = 0; i < plan.legs.length; i++) {
      const leg = plan.legs[i] as (typeof plan.legs)[number];

      const legKey = `${p.idempotencyKey}:fee:${i}`;
      try {
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
      } catch {}
    }
  }

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
