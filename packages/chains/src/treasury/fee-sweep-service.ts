import type { GatherLease, GatherStrategyRegistry } from "@cixtech/attribution";
import { AppError } from "@cixtech/errors";
import { feeSwept } from "@cixtech/ledger";
import type { LedgerService, SqlClient } from "@cixtech/ledger";
import { Asset, IdempotencyKey, JournalEntryId, LedgerAccountKey } from "@cixtech/types";
import type { AuthorizationSigner } from "../payout/authorization.js";
import type { PayoutBroadcaster } from "../payout/broadcaster.js";
import { mintInternalAuthorization } from "../payout/internal-authorization.js";
import type { FeeSweepPlanner } from "./fee-sweep-planner.js";

/** No treasury address is configured, so a real transfer has nowhere to go. */
export class FeeTreasuryNotConfiguredError extends AppError {
  readonly code = "FEE_TREASURY_NOT_CONFIGURED";
}

/** A sweep moves value, so it halts with everything else. */
export class SweepHaltedError extends AppError {
  readonly code = "SWEEP_HALTED";
}

export interface FeeSweepResult {
  sweptCount: number;
  totalSweptAmount: string;
  asset: string;
  /** Merchants that hold a claim but could not be settled, and why. */
  skipped: Array<{ merchant: string; chain: string; reason: string }>;
}

export interface FeeSweepServiceOptions {
  /** Where the platform's share goes, per chain. Absent for a chain = no sweep there. */
  treasuryAddressFor: (chain: string) => string | undefined;
  /** Provisions native gas before a token transfer (ADR 0011). */
  gatherStrategies?: GatherStrategyRegistry;
  /**
   * Mints the authorization token each sweep leg carries (§7). Required whenever
   * the broadcaster is the authorizing one, since a transfer with no token is
   * refused at the signing boundary — which is the point.
   */
  authorizer?: AuthorizationSigner;
  /**
   * The same lease payouts take. Without it this races the payout path for the
   * same balances — the console is a third writer against those addresses, not a
   * privileged one.
   */
  gatherLease?: GatherLease;
  /**
   * Refuses to move money while the breaker is engaged. Shaped like the payout
   * path's `KillSwitch` so the same SqlKillSwitch instance satisfies both — a
   * sweep must not be able to obey a different halt from a payout.
   */
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

/**
 * Collects the platform's accrued fee on demand — the console button.
 *
 * The fee is normally taken during a payout, because the engine is already
 * sending a transaction out of those addresses and the fee can ride along for
 * one extra transfer instead of a gather of its own (§6.3). This exists for the
 * balances that have no payout coming: a merchant who stopped withdrawing still
 * has the platform's share sitting in their pool addresses.
 *
 * It is the SAME primitive either way — `FeeSweepPlanner` decides what is owed
 * and which addresses can pay it, a real transfer moves it, and the ledger entry
 * is posted only once that transfer is away.
 *
 * That last point is why the previous implementation had to go. It posted the
 * ledger entry and moved nothing: `pool_addr` fell while the coins stayed where
 * they were, which is precisely the mismatch `ExternalReconciler` treats as
 * theft. Running it and then enabling the reconciler would trip the circuit
 * breaker and freeze every withdrawal. Its idempotency key also carried
 * `Date.now()`, so a retry or a double click posted a second entry.
 */
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
      // A sweep moves value, so it obeys the same halt as a payout. Collecting
      // revenue is never urgent enough to be a side door around the breaker.
      throw new SweepHaltedError(
        "Kill-switch is engaged — refusing to move funds. Resume payouts first.",
        { exposable: true },
      );
    }

    const { rows: groups } = await this.sql.query<{
      tenant: string;
      merchant: string;
      chain: string;
    }>("SELECT DISTINCT tenant, merchant, chain FROM pool_address ORDER BY chain, merchant");

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

      // A merchant mid-payout is skipped rather than waited on: their fee will
      // be taken by that very payout, or by the next run of this.
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
          // Deterministic in the address and amount rather than the clock, so a
          // retry lands on the same key and the ledger absorbs it.
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
            // A sweep is a real transfer out of a custody address, so it carries
            // the same authorization binding a tenant payout does — otherwise the
            // authorizing broadcaster refuses it, and rightly so.
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
