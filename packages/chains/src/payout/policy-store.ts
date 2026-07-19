import type { SqlClient } from "@cixtech/ledger";
import {
  type KillSwitch,
  type PayoutContext,
  PolicyDeniedError,
  type VelocityConfig,
  type VelocityLimiter,
} from "./policy.js";

/**
 * Durable state for the money-out guardrails (build spec §7). The in-memory
 * kill-switch and velocity limiter lose their state on restart and are not shared
 * across engine nodes; these SQL-backed versions survive restarts and are correct
 * under multiple concurrent signers.
 */
export const POLICY_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS policy_kill_switch (
  scope      text PRIMARY KEY,
  engaged    boolean NOT NULL DEFAULT false,
  reason     text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS policy_payout_log (
  id                bigserial PRIMARY KEY,
  tenant            text NOT NULL,
  merchant          text NOT NULL,
  asset             text NOT NULL,
  amount_base_units numeric(78,0) NOT NULL,
  at                timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS policy_payout_log_window
  ON policy_payout_log(tenant, merchant, asset, at);
`;

const GLOBAL = "global";

/**
 * Kill-switch backed by a single row, so an incident halt set on one node halts
 * every node and survives a restart. Absent row = not engaged.
 */
export class SqlKillSwitch implements KillSwitch {
  constructor(
    private readonly sql: SqlClient,
    private readonly scope: string = GLOBAL,
  ) {}

  async engaged(_ctx: PayoutContext): Promise<boolean> {
    const { rows } = await this.sql.query<{ engaged: boolean }>(
      "SELECT engaged FROM policy_kill_switch WHERE scope = $1",
      [this.scope],
    );
    return rows[0]?.engaged ?? false;
  }

  async engage(reason: string): Promise<void> {
    await this.sql.query(
      `INSERT INTO policy_kill_switch (scope, engaged, reason, updated_at)
       VALUES ($1, true, $2, now())
       ON CONFLICT (scope) DO UPDATE SET engaged = true, reason = $2, updated_at = now()`,
      [this.scope, reason],
    );
  }

  async reset(): Promise<void> {
    await this.sql.query(
      `INSERT INTO policy_kill_switch (scope, engaged, reason, updated_at)
       VALUES ($1, false, null, now())
       ON CONFLICT (scope) DO UPDATE SET engaged = false, reason = null, updated_at = now()`,
      [this.scope],
    );
  }
}

/** FNV-1a hash of a key into a signed 64-bit int, for a per-merchant advisory lock. */
function advisoryKey(s: string): bigint {
  let h = 1469598103934665603n;
  const MASK = 0xffffffffffffffffn;
  for (let i = 0; i < s.length; i++) {
    h = ((h ^ BigInt(s.charCodeAt(i))) * 1099511628211n) & MASK;
  }
  return h >= 0x8000000000000000n ? h - 0x10000000000000000n : h;
}

/**
 * Rolling-window velocity limiter backed by an append log, correct across nodes.
 * `admit` runs in one transaction: it takes a per-(tenant, merchant, asset)
 * advisory lock so concurrent admits for the same merchant serialize (no two
 * signers can each read a stale sum and both slip under the cap), sums the window,
 * denies on breach, and records the payout on allow. Recording before broadcast
 * makes it fail CLOSED — a failed broadcast still consumes budget until it ages out.
 */
export class SqlVelocityLimiter implements VelocityLimiter {
  constructor(
    private readonly sql: SqlClient,
    private readonly config: VelocityConfig,
  ) {}

  async admit(ctx: PayoutContext, now: Date): Promise<void> {
    const cutoff = new Date(now.getTime() - this.config.windowMs).toISOString();
    const key = `${ctx.tenant}:${ctx.merchant}:${ctx.asset}`;

    await this.sql.transaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock($1::bigint)", [advisoryKey(key).toString()]);

      const { rows } = await tx.query<{ spent: string }>(
        `SELECT COALESCE(SUM(amount_base_units), 0)::text AS spent
           FROM policy_payout_log
          WHERE tenant = $1 AND merchant = $2 AND asset = $3 AND at >= $4`,
        [ctx.tenant, ctx.merchant, ctx.asset, cutoff],
      );
      const spent = BigInt(rows[0]?.spent ?? "0");
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

      await tx.query(
        `INSERT INTO policy_payout_log (tenant, merchant, asset, amount_base_units, at)
         VALUES ($1, $2, $3, $4, $5)`,
        [ctx.tenant, ctx.merchant, ctx.asset, ctx.amountBaseUnits.toString(), now.toISOString()],
      );
      // Housekeeping: drop this key's rows that have aged out of every future window.
      await tx.query(
        "DELETE FROM policy_payout_log WHERE tenant = $1 AND merchant = $2 AND asset = $3 AND at < $4",
        [ctx.tenant, ctx.merchant, ctx.asset, cutoff],
      );
    });
  }
}
