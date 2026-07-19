import { AppError } from "@cixtech/errors";

export interface PayoutContext {
  tenant: string;
  merchant: string;
  chain: string;
  asset: string;
  amountBaseUnits: bigint;
  destination: string;
}

/**
 * Engine-wide incident halt: when engaged, EVERY payout is denied regardless of
 * amount or destination. The break-glass control for an active incident. Pluggable
 * so it can be backed by a flag, a config row, or an ops API.
 */
export interface KillSwitch {
  engaged(ctx: PayoutContext): boolean | Promise<boolean>;
}

/** Screens a destination against a sanctions / blocklist (OFAC etc.). */
export interface SanctionsScreener {
  isBlocked(address: string): boolean | Promise<boolean>;
}

/**
 * Rolling-window spend cap per merchant. `admit` denies the payout if it would
 * breach the window, and records it on allow. Recording happens at policy time
 * (before broadcast) so it fails CLOSED: a failed broadcast still consumes budget
 * until it ages out — safe against retry-storm draining.
 */
export interface VelocityLimiter {
  admit(ctx: PayoutContext, now: Date): void | Promise<void>;
}

export interface PolicyConfig {
  /** Oracle-free native-asset hard ceiling per payout (§7 — a USD cap would depend on a price oracle). */
  maxPerPayoutBaseUnits: bigint;
  /** Destinations a payout may go to. A new address must be added out-of-band first. */
  allowlist: ReadonlySet<string>;
  /** Optional break-glass halt. Absent = never halted. */
  killSwitch?: KillSwitch;
  /** Optional sanctions screen. Absent = no screening. */
  sanctions?: SanctionsScreener;
  /** Optional rolling-window spend cap. Absent = no velocity limit. */
  velocity?: VelocityLimiter;
}

export class PolicyDeniedError extends AppError {
  readonly code = "POLICY_DENIED";
}

/**
 * The money-out security boundary (build spec §7). Layers, most-blocking first:
 * kill-switch, positive amount, oracle-free per-payout ceiling, destination
 * allow-list, sanctions screen, rolling velocity cap. The guard runs BEFORE any
 * signing; signing is the last mile, never the decision. Async because screening
 * and velocity may hit an external list or a store.
 */
export class PolicyEngine {
  constructor(private readonly config: PolicyConfig) {}

  async check(ctx: PayoutContext, now: Date = new Date()): Promise<void> {
    if (this.config.killSwitch && (await this.config.killSwitch.engaged(ctx))) {
      throw new PolicyDeniedError("Payouts are halted (kill-switch engaged)", {
        context: { tenant: ctx.tenant, merchant: ctx.merchant },
      });
    }
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
    if (this.config.sanctions && (await this.config.sanctions.isBlocked(ctx.destination))) {
      throw new PolicyDeniedError("Destination is sanctions-screened", {
        context: { destination: ctx.destination },
      });
    }
    if (this.config.velocity) {
      await this.config.velocity.admit(ctx, now);
    }
  }
}

/** A simple in-process kill-switch flag; production would back this with a store. */
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

/** Sanctions screen backed by a static denylist. Production swaps in a live feed. */
export class DenylistSanctionsScreener implements SanctionsScreener {
  constructor(private readonly blocked: ReadonlySet<string>) {}
  isBlocked(address: string): boolean {
    return this.blocked.has(address);
  }
}

export interface VelocityConfig {
  /** Window length in milliseconds. */
  windowMs: number;
  /** Max total base units a single merchant+asset may pay out within the window. */
  maxTotalBaseUnits: bigint;
}

/**
 * In-memory rolling-window velocity limiter, per (tenant, merchant, asset).
 * Production backs this with the ledger/a store so it survives restarts and is
 * shared across nodes; the semantics here are the contract.
 */
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
