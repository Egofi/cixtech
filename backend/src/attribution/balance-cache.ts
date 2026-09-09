import { kyselyFor } from "@/postgres";
import { poolAddress, poolAddressBalance } from "@/queries";
import type { BalanceTarget, Db, RefreshSummary, SqlClient } from "@/types";
import type { AddressBalance } from "./pool-gatherer.js";

export class PoolBalanceCache {
  private readonly db: Db;

  constructor(sql: SqlClient) {
    this.db = kyselyFor(sql);
  }

  async targets(assetsForChain: (chain: string) => readonly string[]): Promise<BalanceTarget[]> {
    const rows = await poolAddress.addressesOrderedByIndex(this.db).execute();
    const out: BalanceTarget[] = [];
    for (const r of rows) {
      for (const asset of assetsForChain(r.chain)) {
        out.push({ chain: r.chain, address: r.address, asset });
      }
    }
    return out;
  }

  async record(
    target: BalanceTarget,
    balance: bigint,
    source: string,
    at: Date = new Date(),
  ): Promise<void> {
    await poolAddressBalance
      .record(this.db, {
        chain: target.chain,
        address: target.address,
        asset: target.asset,
        balance_base_units: balance.toString(),
        observed_at: at,
        source,
      })
      .execute();
  }

  async recordFailure(target: BalanceTarget, error: string): Promise<void> {
    await poolAddressBalance
      .recordFailure(this.db, {
        chain: target.chain,
        address: target.address,
        asset: target.asset,
        last_error: error.slice(0, 500),
      })
      .execute();
  }

  async refresh(
    targets: BalanceTarget[],
    balances: AddressBalance,
    opts: { concurrency?: number; source?: string } = {},
  ): Promise<RefreshSummary> {
    const concurrency = Math.max(1, opts.concurrency ?? 4);
    const source = opts.source ?? "worker";
    let observed = 0;
    let failed = 0;
    let cursor = 0;

    const runOne = async (): Promise<void> => {
      while (cursor < targets.length) {
        const target = targets[cursor++] as BalanceTarget;
        try {
          const value = await balances.balance(target.chain, target.address, target.asset);
          await this.record(target, value, source);
          observed++;
        } catch (err) {
          await this.recordFailure(target, err instanceof Error ? err.message : String(err));
          failed++;
        }
      }
    };

    await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, runOne));
    return { observed, failed };
  }
}
