import { AccountType, type AssetSolvency, type TotalsByType } from "@/types";

const sumForAsset = (totals: TotalsByType, type: AccountType, asset: string): bigint =>
  totals.get(type)?.get(asset) ?? 0n;

export function assetSolvency(totals: TotalsByType, asset: string): AssetSolvency {
  return {
    asset,
    assets: sumForAsset(totals, AccountType.Asset, asset),
    liabilities: sumForAsset(totals, AccountType.Liability, asset),
  };
}

export const isSolvent = (s: AssetSolvency): boolean => s.assets >= s.liabilities;

export function solvencyDrift(totals: TotalsByType, assets: Iterable<string>): AssetSolvency[] {
  const bad: AssetSolvency[] = [];
  for (const asset of assets) {
    const s = assetSolvency(totals, asset);
    if (!isSolvent(s)) bad.push(s);
  }
  return bad;
}
