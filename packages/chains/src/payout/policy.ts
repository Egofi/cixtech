import { AppError } from "@cixtech/errors";

export interface PayoutContext {
  tenant: string;
  merchant: string;
  chain: string;
  asset: string;
  amountBaseUnits: bigint;
  destination: string;
}

export interface PolicyConfig {
  /** Oracle-free native-asset hard ceiling per payout (§7 — a USD cap would depend on a price oracle). */
  maxPerPayoutBaseUnits: bigint;
  /** Destinations a payout may go to. A new address must be added out-of-band first. */
  allowlist: ReadonlySet<string>;
}

export class PolicyDeniedError extends AppError {
  readonly code = "POLICY_DENIED";
}

/**
 * The money-out security boundary (build spec §7), minimal first cut: positive
 * amount, an oracle-free per-payout ceiling, and a destination allow-list.
 * Velocity windows, allow-list cool-down, dual approval, sanctions and the
 * kill-switch are the next layers — this is the seam they slot into. The guard
 * runs BEFORE any signing; signing is the last mile, never the decision.
 */
export class PolicyEngine {
  constructor(private readonly config: PolicyConfig) {}

  check(ctx: PayoutContext): void {
    if (ctx.amountBaseUnits <= 0n) {
      throw new PolicyDeniedError("Payout amount must be positive", {
        context: { ...ctx, amountBaseUnits: ctx.amountBaseUnits.toString() },
      });
    }
    if (ctx.amountBaseUnits > this.config.maxPerPayoutBaseUnits) {
      throw new PolicyDeniedError("Payout exceeds the per-payout limit", {
        context: {
          requested: ctx.amountBaseUnits.toString(),
          limit: this.config.maxPerPayoutBaseUnits.toString(),
        },
      });
    }
    if (!this.config.allowlist.has(ctx.destination)) {
      throw new PolicyDeniedError("Destination is not allow-listed", {
        context: { destination: ctx.destination },
      });
    }
  }
}
