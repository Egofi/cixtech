import { assetRegistry } from "./tokens.js";

/**
 * How many decimal places an asset's base units carry, or null if the asset is
 * not in the registry. Null means "we cannot scale this" — never assume 6.
 */
export function decimalsFor(symbol: string): number | null {
  const wanted = symbol.toUpperCase();
  return assetRegistry().find((a) => a.symbol === wanted)?.decimals ?? null;
}

/**
 * Render a base-unit integer as a decimal string using the asset's own scale.
 *
 * Pure string and bigint arithmetic. `Number` is never involved: a balance in
 * base units passes 2^53 at ~9 USDT or ~0.01 ETH, past which a float silently
 * rounds — and an 18-decimal asset scaled as if it were 6-decimal is wrong by a
 * factor of a trillion. Both are why principle 8 keeps floats out of the money
 * path, and this is the money path's display edge.
 *
 * Returns null for an unregistered asset rather than guessing a scale; callers
 * fall back to quoting raw base units, which is imprecise but never wrong.
 */
export function formatBaseUnits(amount: bigint, symbol: string): string | null {
  const decimals = decimalsFor(symbol);
  if (decimals === null) return null;

  const negative = amount < 0n;
  const digits = (negative ? -amount : amount).toString();
  const sign = negative ? "-" : "";

  if (decimals === 0) return `${sign}${digits}`;

  const padded = digits.padStart(decimals + 1, "0");
  const whole = padded.slice(0, padded.length - decimals);
  const fraction = padded.slice(padded.length - decimals).replace(/0+$/, "");
  return fraction ? `${sign}${whole}.${fraction}` : `${sign}${whole}`;
}

/**
 * `formatBaseUnits` with the symbol appended, falling back to an explicit
 * "base units" phrasing when the asset has no known scale — so a reader can
 * always tell a scaled amount from an unscaled one.
 */
export function describeAmount(amount: bigint, symbol: string): string {
  const scaled = formatBaseUnits(amount, symbol);
  const asset = symbol.toUpperCase();
  return scaled === null ? `${amount.toString()} ${asset} base units` : `${scaled} ${asset}`;
}

/**
 * Total base units per asset. Amounts in different assets are never added —
 * a sum across assets is not a balance in any of them.
 *
 * Accepts `string` (as `pg` returns `numeric`) or `bigint`.
 */
export function totalsByAsset(
  rows: ReadonlyArray<{ asset: string; amount: string | bigint }>,
): Map<string, bigint> {
  const totals = new Map<string, bigint>();
  for (const row of rows) {
    const asset = row.asset.toUpperCase();
    totals.set(asset, (totals.get(asset) ?? 0n) + BigInt(row.amount));
  }
  return totals;
}
