import { AccountType } from "@/types";

/** Per-asset totals, grouped by account type, for the solvency check. */
export type TotalsByType = Map<AccountType, Map<string, bigint>>;

export interface AssetSolvency {
  readonly asset: string;
  readonly assets: bigint;
  readonly liabilities: bigint;
}

const sumForAsset = (totals: TotalsByType, type: AccountType, asset: string): bigint =>
  totals.get(type)?.get(asset) ?? 0n;

/**
 * ADR 0010 invariant, per asset:
 *   Σ ASSET(pool_addr + treasury + cold + gas_float) ≥ Σ LIABILITY(available + pending
 *     + pending_withdrawal + compliance_suspense)
 * ASSET accounts carry a debit-normal (positive) balance; LIABILITY a credit-normal
 * balance, which the store returns as a positive magnitude here.
 */
export function assetSolvency(totals: TotalsByType, asset: string): AssetSolvency {
  return {
    asset,
    assets: sumForAsset(totals, AccountType.Asset, asset),
    liabilities: sumForAsset(totals, AccountType.Liability, asset),
  };
}

export const isSolvent = (s: AssetSolvency): boolean => s.assets >= s.liabilities;

/** Returns the assets that violate the invariant. Empty array == solvent. */
export function solvencyDrift(totals: TotalsByType, assets: Iterable<string>): AssetSolvency[] {
  const bad: AssetSolvency[] = [];
  for (const asset of assets) {
    const s = assetSolvency(totals, asset);
    if (!isSolvent(s)) bad.push(s);
  }
  return bad;
}
