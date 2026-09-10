import { PolicyDeniedError } from "@/common";
import { kyselyFor } from "@/postgres";
import { allowlist as allowlistQ, killSwitch, payoutLog } from "@/queries";
import type { PayoutContext, SqlClient, VelocityConfig } from "@/types";

import type { Allowlist, KillSwitch, VelocityLimiter } from "@/chains/payout/policy.js";

const GLOBAL = "global";

export class SqlKillSwitch implements KillSwitch {
  constructor(
    private readonly sql: SqlClient,
    private readonly scope: string = GLOBAL,
  ) {}

  async engaged(_ctx: PayoutContext): Promise<boolean> {
    const row = await killSwitch.isEngaged(kyselyFor(this.sql), this.scope).executeTakeFirst();
    return row?.engaged ?? false;
  }

  async engage(reason: string): Promise<void> {
    await killSwitch.set(kyselyFor(this.sql), this.scope, true, reason).execute();
  }

  async trip(reason: string): Promise<void> {
    return this.engage(reason);
  }

  async reset(): Promise<void> {
    await killSwitch.set(kyselyFor(this.sql), this.scope, false, null).execute();
  }
}

function advisoryKey(s: string): bigint {
  let h = 1469598103934665603n;
  const MASK = 0xffffffffffffffffn;
  for (let i = 0; i < s.length; i++) {
    h = ((h ^ BigInt(s.charCodeAt(i))) * 1099511628211n) & MASK;
  }
  return h >= 0x8000000000000000n ? h - 0x10000000000000000n : h;
}

export class SqlVelocityLimiter implements VelocityLimiter {
  constructor(
    private readonly sql: SqlClient,
    private readonly config: VelocityConfig,
  ) {}

  async admit(ctx: PayoutContext, now: Date): Promise<void> {
    const cutoffDate = new Date(now.getTime() - this.config.windowMs);
    const key = `${ctx.tenant}:${ctx.merchant}:${ctx.asset}`;

    await this.sql.transaction(async (tx) => {
      const db = kyselyFor(tx);
      await payoutLog.lockWindow(db, advisoryKey(key).toString());

      const window = await payoutLog
        .spentSince(db, ctx.tenant, ctx.merchant, ctx.asset, cutoffDate)
        .executeTakeFirst();
      const spent = BigInt(window?.spent ?? "0");
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

      await payoutLog
        .record(db, {
          tenant: ctx.tenant,
          merchant: ctx.merchant,
          asset: ctx.asset,
          amount_base_units: ctx.amountBaseUnits.toString(),
          at: now,
        })
        .execute();

      await payoutLog.prune(db, ctx.tenant, ctx.merchant, ctx.asset, cutoffDate).execute();
    });
  }
}

export class SqlAllowlist implements Allowlist {
  constructor(private readonly sql: SqlClient) {}

  async add(
    tenant: string,
    merchant: string,
    chain: string,
    address: string,
    cooldownMs: number,
    now: Date = new Date(),
  ): Promise<{ usableAt: Date }> {
    const usableAt = new Date(now.getTime() + Math.max(0, cooldownMs));

    const rows = await allowlistQ
      .add(kyselyFor(this.sql), {
        tenant,
        merchant,
        chain,
        address,
        usable_at: usableAt,
        added_at: now,
      })
      .execute();
    return { usableAt: rows[0] ? new Date(rows[0].usable_at) : usableAt };
  }

  async remove(tenant: string, merchant: string, chain: string, address: string): Promise<boolean> {
    const rows = await allowlistQ
      .remove(kyselyFor(this.sql), tenant, merchant, chain, address)
      .execute();
    return rows.length > 0;
  }

  async usable(ctx: PayoutContext, now: Date): Promise<boolean> {
    const row = await allowlistQ
      .usableAt(kyselyFor(this.sql), ctx.tenant, ctx.merchant, ctx.chain, ctx.destination)
      .executeTakeFirst();
    return row !== undefined && new Date(row.usable_at) <= now;
  }

  async list(
    tenant: string,
    limit = 50,
  ): Promise<
    Array<{ merchant: string; chain: string; address: string; usableAt: Date; addedAt: Date }>
  > {
    const rows = await allowlistQ.listFor(kyselyFor(this.sql), tenant, limit).execute();
    return rows.map((r) => ({
      merchant: r.merchant,
      chain: r.chain,
      address: r.address,
      usableAt: new Date(r.usable_at),
      addedAt: new Date(r.added_at),
    }));
  }
}
