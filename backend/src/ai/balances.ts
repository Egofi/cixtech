import { totalsByAsset } from "@/chain-config";
import { normalBalance } from "@/ledger";
import type { LedgerAccountKey } from "@/types";

/**
 * Per-asset totals in each account's **normal** direction.
 *
 * `balance.amount` is a signed net with DEBIT positive, so a liability such as
 * `merchant_available` is stored negative and a revenue account likewise. Summing
 * the column raw reports a merchant's float as a negative number. `normalBalance`
 * flips each account into the direction it is normally carried in — the same
 * conversion `PortalService.balances` applies before showing a balance to anyone.
 */
export function normalTotalsByAsset(
  rows: ReadonlyArray<{ account: string; asset: string; amount: string }>,
): Map<string, bigint> {
  return totalsByAsset(
    rows.map((r) => ({
      asset: r.asset,
      amount: normalBalance(r.account as LedgerAccountKey, BigInt(r.amount)),
    })),
  );
}
