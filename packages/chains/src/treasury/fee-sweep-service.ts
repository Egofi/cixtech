import { randomUUID } from "node:crypto";
import {
  accountTypeOf,
  feeSwept,
  LedgerService,
  normalBalance,
  SqlLedgerStore,
} from "@cixtech/ledger";
import type { SqlClient } from "@cixtech/ledger";
import {
  Asset,
  IdempotencyKey,
  type JournalEntryId,
  LedgerAccountKey,
} from "@cixtech/types";

export interface FeeSweepResult {
  sweptCount: number;
  totalSweptAmount: string;
  asset: string;
}

/**
 * Sweeps accrued platform fee revenue from deposit pool addresses into the
 * platform treasury (build spec §8 `fee-sweep`).
 *
 * Extracted into `@cixtech/chains` so both the admin console (`AdminService`, on-demand)
 * and the background worker (`FeeSweepWorker`, scheduled) call the same logic.
 */
export class FeeSweepService {
  constructor(private readonly sql: SqlClient) {}

  async sweep(asset = "USDT"): Promise<FeeSweepResult> {
    // 1. Total accrued fee revenue for this asset across all tenants
    const { rows: feeRows } = await this.sql.query<{
      account: string;
      amount: string;
    }>(
      "SELECT account, amount FROM balance WHERE account LIKE 'egofi_fee_revenue:%' AND asset = $1",
      [asset],
    );
    let totalAccruedFee = 0n;
    for (const r of feeRows) {
      totalAccruedFee += normalBalance(
        r.account as LedgerAccountKey,
        BigInt(r.amount),
      );
    }

    // 2. Total fee revenue already swept into treasury accounts
    const { rows: treasuryRows } = await this.sql.query<{
      account: string;
      amount: string;
    }>(
      "SELECT account, amount FROM balance WHERE account LIKE 'treasury:%' AND asset = $1",
      [asset],
    );
    let totalSweptFee = 0n;
    for (const r of treasuryRows) {
      totalSweptFee += normalBalance(
        r.account as LedgerAccountKey,
        BigInt(r.amount),
      );
    }

    let remainingToSweep =
      totalAccruedFee > totalSweptFee
        ? totalAccruedFee - totalSweptFee
        : 0n;
    if (remainingToSweep <= 0n) {
      return { sweptCount: 0, totalSweptAmount: "0", asset };
    }

    // 3. Query pool addresses with positive float to sweep from
    const { rows: poolRows } = await this.sql.query<{
      account: string;
      amount: string;
    }>(
      "SELECT account, amount FROM balance WHERE account LIKE 'pool_addr:%' AND asset = $1 AND amount > 0 ORDER BY amount DESC",
      [asset],
    );

    let sweptCount = 0;
    let totalSweptBig = 0n;
    const ledger = new LedgerService(new SqlLedgerStore(this.sql));

    for (const pr of poolRows) {
      if (remainingToSweep <= 0n) break;
      const poolBal = BigInt(pr.amount);
      if (poolBal <= 0n) continue;

      const sweepAmt =
        poolBal < remainingToSweep ? poolBal : remainingToSweep;

      const entry = feeSwept({
        id: randomUUID() as JournalEntryId,
        idempotencyKey: IdempotencyKey(
          `fee-sweep:${pr.account}:${Date.now()}`,
        ),
        asset: Asset(asset),
        amount: sweepAmt,
        poolAddr: LedgerAccountKey(pr.account),
        treasury: LedgerAccountKey("treasury:PLATFORM"),
      });

      await ledger.post(entry);
      totalSweptBig += sweepAmt;
      remainingToSweep -= sweepAmt;
      sweptCount++;
    }

    return {
      sweptCount,
      totalSweptAmount: totalSweptBig.toString(),
      asset,
    };
  }
}
