import { AppError } from "@/errors";

export interface PayoutContext {
  tenant: string;
  merchant: string;
  chain: string;
  asset: string;
  amountBaseUnits: bigint;
  destination: string;
  /** Identity that requested the payout — never counts as one of its own approvers (SoD, §7.4). */
  requester?: string;
  /** Distinct operator identities that have approved this intent (dual control, §7.4). */
  approvals?: readonly string[];
  /** When the intent was first recorded — the anchor for the time-lock delay (§7.5). */
  requestedAt?: Date;
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

/**
 * Fail-CLOSED solvency probe (§7.7, ADR 0010). `solvent` returns true only when
 * the engine can PROVE Σ ASSET ≥ Σ LIABILITY for the asset; a store error or an
 * unreachable reconciler must surface as an exception so the guard denies rather
 * than assuming solvency.
 */
export interface SolvencyOracle {
  solvent(asset: string): Promise<boolean>;
}

/**
 * Destination allow-list WITH a cool-down (§7.2). `usable` is true only when the
 * destination is allow-listed for this account AND its cool-down has elapsed — so
 * an attacker who adds their own address cannot drain in the same session. Backed
 * by a store (per (tenant, merchant, chain, address) with a `usableAt`).
 */
export interface Allowlist {
  usable(ctx: PayoutContext, now: Date): Promise<boolean> | boolean;
}

/** Above `thresholdBaseUnits`, require `required` distinct approvals; the requester never counts (§7.4). */
export interface ApprovalPolicy {
  thresholdBaseUnits: bigint;
  required: number;
}

/** Above `thresholdBaseUnits`, hold signing until `requestedAt + delayMs` — the cancel window (§7.5). */
export interface TimeLockPolicy {
  thresholdBaseUnits: bigint;
  delayMs: number;
}

export interface PolicyConfig {
  /** Oracle-free native-asset hard ceiling per payout (§7 — a USD cap would depend on a price oracle). */
  maxPerPayoutBaseUnits: bigint;
  /** Static destination set. Immediately usable; superseded by `allowlistStore` when present. */
  allowlist: ReadonlySet<string>;
  /** Durable, cool-down-aware allow-list (§7.2). When present it decides destination admissibility. */
  allowlistStore?: Allowlist;
  /** Optional break-glass halt. Absent = never halted. */
  killSwitch?: KillSwitch;
  /** Optional sanctions screen. Absent = no screening. */
  sanctions?: SanctionsScreener;
  /** Fail-closed solvency gate (§7.7). Absent = no gate (dev/test only). */
  solvency?: SolvencyOracle;
  /** Dual-approval threshold + quorum (§7.4). Absent = never requires approval. */
  approval?: ApprovalPolicy;
  /** Time-lock threshold + delay (§7.5). Absent = no delay. */
  timeLock?: TimeLockPolicy;
  /** Optional rolling-window spend cap. Absent = no velocity limit. */
  velocity?: VelocityLimiter;
}

export class PolicyDeniedError extends AppError {
  readonly code = "POLICY_DENIED";
}

/** The intent needs more distinct approvals before it can be signed (§7.4). No funds move. */
export class ApprovalRequiredError extends AppError {
  readonly code = "POLICY_APPROVAL_REQUIRED";
}

/** The intent is under a time-lock; it may be signed only after `until` (§7.5). No funds move. */
export class TimeLockedError extends AppError {
  readonly code = "POLICY_TIME_LOCKED";
}

/** The destination is held for compliance review (§7.6). No funds move. */
export class ComplianceHoldError extends AppError {
  readonly code = "POLICY_COMPLIANCE_HOLD";
}

/** The five §7 outcomes: only ALLOW may proceed to signing. */
export type PolicyDecision =
  | { type: "ALLOW" }
  | { type: "DENY"; reason: string }
  | { type: "REQUIRE_APPROVAL"; needed: number; have: number }
  | { type: "HOLD"; reason: string }
  | { type: "DELAY"; until: Date };

/**
 * The money-out security boundary (build spec §7). Layers, most-blocking first:
 * kill-switch, positive amount, oracle-free per-payout ceiling, destination
 * allow-list, sanctions screen, rolling velocity cap. The guard runs BEFORE any
 * signing; signing is the last mile, never the decision. Async because screening
 * and velocity may hit an external list or a store.
 */
export class PolicyEngine {
  constructor(private readonly config: PolicyConfig) {}

  /**
   * Evaluate the money-out guard (build spec §7), most-blocking first, returning
   * one of the five §7 outcomes. Only `ALLOW` may proceed to signing. Reaching
   * `ALLOW` records velocity budget (fail-closed), so a payout that is held,
   * delayed, or awaiting approval consumes no budget until it is actually allowed.
   * Callers use `check()` when they only care allow-vs-throw.
   */
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

    // Allow-list (§7.2): admissible if it's on the operator-curated static set
    // (added out-of-band, no cool-down needed) OR the durable per-account store
    // says it is usable — i.e. added AND past its cool-down. A freshly tenant-added
    // address is denied until its cool-down elapses.
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

    // Solvency gate — fail closed: an unreachable oracle throws and denies (§7.7).
    if (this.config.solvency && !(await this.config.solvency.solvent(ctx.asset))) {
      return { type: "DENY", reason: "Refused: solvency invariant not satisfied for asset" };
    }

    // Dual approval + separation of duties (§7.4): the requester is never a valid approver.
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

    // Time-lock (§7.5): a high-value intent may sign only after the cancel window.
    if (this.config.timeLock && ctx.amountBaseUnits > this.config.timeLock.thresholdBaseUnits) {
      const anchor = ctx.requestedAt ?? now;
      const until = new Date(anchor.getTime() + this.config.timeLock.delayMs);
      if (now < until) return { type: "DELAY", until };
    }

    // Velocity is last: only an otherwise-ALLOW payout consumes rolling budget.
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

  /**
   * Assert the payout may proceed to signing NOW, throwing the specific §7 error
   * otherwise (kept for callers and tests that only need allow-vs-deny). Anything
   * that is not `ALLOW` throws and moves no funds.
   */
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
