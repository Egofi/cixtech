import type { GatherLease } from "@/attribution";
import type { GatherStrategyRegistry } from "@/attribution";
import { SweepHaltedError } from "@/common";
import { feeSwept } from "@/ledger";
import { kyselyFor } from "@/postgres";
import { poolAddress } from "@/queries";
import type { LedgerService } from "@/services";

import type { AuthorizationSigner } from "@/chains/payout/authorization.js";
import type { PayoutBroadcaster } from "@/chains/payout/broadcaster.js";
import { mintInternalAuthorization } from "@/chains/payout/internal-authorization.js";
import type { FeeSweepPlanner } from "@/chains/treasury/fee-sweep-planner.js";
import {
  Asset,
  type FeeSweepResult,
  IdempotencyKey,
  JournalEntryId,
  LedgerAccountKey,
  type SqlClient,
} from "@/types";

export interface FeeSweepServiceOptions {
  treasuryAddressFor: (chain: string) => string | undefined;

  gatherStrategies?: GatherStrategyRegistry;

  authorizer?: AuthorizationSigner;

  gatherLease?: GatherLease;

  killSwitch?: {
    engaged(ctx: {
      tenant: string;
      merchant: string;
      chain: string;
      asset: string;
      amountBaseUnits: bigint;
      destination: string;
    }): Promise<boolean>;
  };
}

export class FeeSweepService {
  constructor(
    private readonly sql: SqlClient,
    private readonly ledger: LedgerService,
    private readonly planner: FeeSweepPlanner,
    private readonly broadcaster: PayoutBroadcaster,
    private readonly options: FeeSweepServiceOptions,
  ) {}

  async sweep(asset = "USDT"): Promise<FeeSweepResult> {
    const skipped: FeeSweepResult["skipped"] = [];

    const halted = await this.options.killSwitch?.engaged({
      tenant: "",
      merchant: "",
      chain: "",
      asset,
      amountBaseUnits: 0n,
      destination: "",
    });
    if (halted) {
      throw new SweepHaltedError(
        "Kill-switch is engaged — refusing to move funds. Resume payouts first.",
        { exposable: true },
      );
    }

    const groups = await poolAddress.groups(kyselyFor(this.sql)).execute();

    let sweptCount = 0;
    let total = 0n;

    for (const g of groups) {
      const treasuryAddress = this.options.treasuryAddressFor(g.chain);
      if (!treasuryAddress) {
        skipped.push({
          merchant: g.merchant,
          chain: g.chain,
          reason: "no treasury address configured",
        });
        continue;
      }

      const holder = `console-sweep:${asset}`;
      const heldLease = this.options.gatherLease
        ? await this.options.gatherLease.acquire(g.tenant, g.merchant, g.chain, holder)
        : true;
      if (!heldLease) {
        skipped.push({
          merchant: g.merchant,
          chain: g.chain,
          reason: "a payout is spending these addresses right now",
        });
        continue;
      }
      try {
        const plan = await this.planner.plan(g.tenant, g.merchant, g.chain, asset);
        if (plan.claimBaseUnits <= 0n) continue;
        if (plan.legs.length === 0) {
          skipped.push({
            merchant: g.merchant,
            chain: g.chain,
            reason:
              plan.skippedDust > 0
                ? "claim is below the dust threshold — not worth the gas"
                : "claim is not held on this chain",
          });
          continue;
        }

        const treasury = LedgerAccountKey(`treasury:${g.chain}`);
        const pool = LedgerAccountKey(`pool_addr:${g.chain}:${g.merchant}`);

        for (let i = 0; i < plan.legs.length; i++) {
          const leg = plan.legs[i] as (typeof plan.legs)[number];

          const legKey = `fee-sweep:${g.chain}:${leg.address}:${asset}:${leg.amountBaseUnits}`;
          try {
            if (this.options.gatherStrategies) {
              await this.options.gatherStrategies.forAddress(leg.gatherStrategy).prepare({
                chain: g.chain,
                address: leg.address,
                derivationIndex: leg.derivationIndex,
                asset,
                amountBaseUnits: leg.amountBaseUnits,
                idempotencyKey: legKey,
              });
            }

            const authorization = this.options.authorizer
              ? mintInternalAuthorization(this.options.authorizer, {
                  intentId: legKey,
                  chain: g.chain,
                  asset,
                  amountBaseUnits: leg.amountBaseUnits,
                  fromAddress: leg.address,
                  toAddress: treasuryAddress,
                  purpose: "fee-sweep",
                })
              : undefined;
            await this.broadcaster.send({
              chain: g.chain,
              asset,
              amountBaseUnits: leg.amountBaseUnits,
              fromAddress: leg.address,
              fromDerivationIndex: leg.derivationIndex,
              toAddress: treasuryAddress,
              idempotencyKey: legKey,
              ...(authorization ? { authorization } : {}),
            });
            await this.ledger.post(
              feeSwept({
                id: JournalEntryId(legKey),
                idempotencyKey: IdempotencyKey(legKey),
                asset: Asset(asset),
                amount: leg.amountBaseUnits,
                poolAddr: pool,
                treasury,
              }),
            );
            sweptCount++;
            total += leg.amountBaseUnits;
          } catch (err) {
            skipped.push({
              merchant: g.merchant,
              chain: g.chain,
              reason: err instanceof Error ? err.message : String(err),
            });
          }
        }
      } finally {
        await this.options.gatherLease?.release(g.tenant, g.merchant, g.chain, holder);
      }
    }

    return { sweptCount, totalSweptAmount: total.toString(), asset, skipped };
  }
}
