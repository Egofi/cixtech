import {
  ApprovalRequiredError,
  ComplianceHoldError,
  PolicyDeniedError,
  TimeLockedError,
} from "@/common";
import type {
  ApprovalPolicy,
  PayoutContext,
  PolicyDecision,
  TimeLockPolicy,
  VelocityConfig,
} from "@/types";

export interface KillSwitch {
  engaged(ctx: PayoutContext): boolean | Promise<boolean>;
}

export interface SanctionsScreener {
  isBlocked(address: string): boolean | Promise<boolean>;
}

export interface VelocityLimiter {
  admit(ctx: PayoutContext, now: Date): void | Promise<void>;
}

export interface SolvencyOracle {
  solvent(asset: string): Promise<boolean>;
}

export interface Allowlist {
  usable(ctx: PayoutContext, now: Date): Promise<boolean> | boolean;
}

export interface PolicyConfig {
  maxPerPayoutBaseUnits: bigint;

  allowlist: ReadonlySet<string>;

  allowlistStore?: Allowlist;

  killSwitch?: KillSwitch;

  sanctions?: SanctionsScreener;

  solvency?: SolvencyOracle;

  approval?: ApprovalPolicy;

  timeLock?: TimeLockPolicy;

  velocity?: VelocityLimiter;
}

export class PolicyEngine {
  constructor(private readonly config: PolicyConfig) {}

  async evaluate(ctx: PayoutContext, now: Date = new Date()): Promise<PolicyDecision> {
    if (this.config.killSwitch && (await this.config.killSwitch.engaged(ctx))) {
      return { type: "DENY", reason: "Payouts are halted (kill-switch engaged)" };
    }
    if (ctx.amountBaseUnits <= 0n) {
      return { type: "DENY", reason: "Payout amount must be positive" };
    }
    if (ctx.amountBaseUnits > this.config.maxPerPayoutBaseUnits) {
      return { type: "DENY", reason: "Payout exceeds the per-payout limit" };
    }

    const staticAllowed = this.config.allowlist.has(ctx.destination);
    const storeAllowed =
      !staticAllowed && this.config.allowlistStore
        ? await this.config.allowlistStore.usable(ctx, now)
        : false;
    if (!staticAllowed && !storeAllowed) {
      return { type: "DENY", reason: "Destination is not allow-listed or still in cool-down" };
    }

    if (this.config.sanctions && (await this.config.sanctions.isBlocked(ctx.destination))) {
      return { type: "HOLD", reason: "Destination is sanctions-screened" };
    }

    if (this.config.solvency && !(await this.config.solvency.solvent(ctx.asset))) {
      return { type: "DENY", reason: "Refused: solvency invariant not satisfied for asset" };
    }

    if (this.config.approval && ctx.amountBaseUnits > this.config.approval.thresholdBaseUnits) {
      const approvers = new Set((ctx.approvals ?? []).filter((a) => a && a !== ctx.requester));
      if (approvers.size < this.config.approval.required) {
        return {
          type: "REQUIRE_APPROVAL",
          needed: this.config.approval.required,
          have: approvers.size,
        };
      }
    }

    if (this.config.timeLock && ctx.amountBaseUnits > this.config.timeLock.thresholdBaseUnits) {
      const anchor = ctx.requestedAt ?? now;
      const until = new Date(anchor.getTime() + this.config.timeLock.delayMs);
      if (now < until) return { type: "DELAY", until };
    }

    if (this.config.velocity) {
      try {
        await this.config.velocity.admit(ctx, now);
      } catch (err) {
        if (err instanceof PolicyDeniedError) return { type: "DENY", reason: err.message };
        throw err;
      }
    }
    return { type: "ALLOW" };
  }

  async check(ctx: PayoutContext, now: Date = new Date()): Promise<void> {
    const d = await this.evaluate(ctx, now);
    switch (d.type) {
      case "ALLOW":
        return;
      case "REQUIRE_APPROVAL":
        throw new ApprovalRequiredError(
          `Payout requires ${d.needed} distinct approvals (have ${d.have})`,
          { context: { needed: d.needed, have: d.have }, exposable: true },
        );
      case "HOLD":
        throw new ComplianceHoldError(d.reason, {
          context: { destination: ctx.destination },
          exposable: true,
        });
      case "DELAY":
        throw new TimeLockedError(`Payout is time-locked until ${d.until.toISOString()}`, {
          context: { until: d.until.toISOString() },
          exposable: true,
        });
      default:
        throw new PolicyDeniedError(d.reason, {
          context: {
            merchant: ctx.merchant,
            destination: ctx.destination,
            requested: ctx.amountBaseUnits.toString(),
          },
        });
    }
  }
}

export class FlagKillSwitch implements KillSwitch {
  private tripped = false;
  engage(): void {
    this.tripped = true;
  }
  reset(): void {
    this.tripped = false;
  }
  engaged(): boolean {
    return this.tripped;
  }
}

export class DenylistSanctionsScreener implements SanctionsScreener {
  constructor(private readonly blocked: ReadonlySet<string>) {}
  isBlocked(address: string): boolean {
    return this.blocked.has(address);
  }
}

export class InMemoryVelocityLimiter implements VelocityLimiter {
  private readonly log = new Map<string, { at: number; amount: bigint }[]>();

  constructor(private readonly config: VelocityConfig) {}

  admit(ctx: PayoutContext, now: Date): void {
    const key = `${ctx.tenant}:${ctx.merchant}:${ctx.asset}`;
    const cutoff = now.getTime() - this.config.windowMs;
    const recent = (this.log.get(key) ?? []).filter((e) => e.at >= cutoff);
    const spent = recent.reduce((sum, e) => sum + e.amount, 0n);
    if (spent + ctx.amountBaseUnits > this.config.maxTotalBaseUnits) {
      throw new PolicyDeniedError("Payout exceeds the rolling velocity limit", {
        context: {
          merchant: ctx.merchant,
          asset: ctx.asset,
          spent: spent.toString(),
          requested: ctx.amountBaseUnits.toString(),
          limit: this.config.maxTotalBaseUnits.toString(),
        },
      });
    }
    recent.push({ at: now.getTime(), amount: ctx.amountBaseUnits });
    this.log.set(key, recent);
  }
}
