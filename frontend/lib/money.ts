/**
 * Turning integer base units into money.
 *
 * The ledger stores integer base units and the API returns them as STRINGS,
 * because JavaScript loses precision above 2^53 and a balance is the last place
 * to discover that. Nothing here ever converts a base-unit amount to `number`.
 *
 * A UI that prints base units raw is wrong by a factor of 10^decimals — it shows
 * 4.34 USDT as "4,340,000 USDT". Decimals come from the API (`GET /v1/chains`,
 * sourced from the chain-config registry), never from a table in this codebase,
 * because a hardcoded decimals table is a silent way to be wrong about money on a
 * chain nobody remembered to update.
 *
 * An asset the server did not describe is rendered as an explicitly-labelled
 * base-unit count rather than a plausible-looking wrong number.
 */

export interface AssetInfo {
  symbol: string;
  decimals: number;
  chains: string[];
  native: boolean;
}

let ASSETS: Record<string, AssetInfo> = {};

/** Record the asset registry the API reported. Called once per page load. */
export function setAssets(list: readonly AssetInfo[] | undefined): void {
  const next: Record<string, AssetInfo> = {};
  for (const a of list ?? []) next[a.symbol.toUpperCase()] = a;
  ASSETS = next;
}

export function assetInfo(symbol: string | null | undefined): AssetInfo | null {
  return ASSETS[String(symbol ?? "").toUpperCase()] ?? null;
}

/** Thousands separators, applied to a digit string (never to a float). */
export function group(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export interface MoneyParts {
  text: string;
  /**
   * True when this is NOT a decimal amount — either the value was not an integer
   * string, or the asset's decimals are unknown. Callers render it differently so
   * a base-unit count is never mistaken for a balance.
   */
  raw: boolean;
}

/**
 * Format base units for display. Pure string arithmetic, deliberately: shifting
 * the decimal point by slicing the digit string cannot lose precision, and
 * `Number(x) / 10 ** decimals` can.
 */
export function moneyParts(base: string | number | null | undefined, asset?: string): MoneyParts {
  let s = String(base ?? "0");
  const neg = s.startsWith("-");
  if (neg) s = s.slice(1);

  if (!/^[0-9]+$/.test(s)) return { text: String(base ?? ""), raw: true };

  const info = assetInfo(asset);
  if (!info) return { text: `${neg ? "-" : ""}${group(s)} base units`, raw: true };

  const d = info.decimals;
  if (d === 0) return { text: `${neg ? "-" : ""}${group(s)}`, raw: false };

  while (s.length <= d) s = `0${s}`;
  const whole = s.slice(0, s.length - d);
  let frac = s.slice(s.length - d).replace(/0+$/, "");
  while (frac.length < 2) frac += "0";

  return { text: `${neg ? "-" : ""}${group(whole)}.${frac}`, raw: false };
}

/** Just the formatted text. */
export const money = (base: string | number | null | undefined, asset?: string): string =>
  moneyParts(base, asset).text;

/**
 * Convert a human amount ("4.34") to base units. Used by the payout form, where
 * getting this wrong sends the wrong amount of real money.
 *
 * Returns null rather than guessing. In particular it REFUSES an amount with more
 * decimal places than the asset has, instead of silently truncating: someone who
 * types 1.0000001 USDT meant something, and quietly sending 1.000000 is the kind
 * of helpfulness that loses money without telling anyone.
 */
export function toBaseUnits(human: string, asset: string): string | null {
  const info = assetInfo(asset);
  if (!info) return null;

  const m = /^(\d+)(?:\.(\d*))?$/.exec(human.trim());
  if (!m) return null;

  const whole = m[1] ?? "0";
  const frac = m[2] ?? "";
  if (frac.length > info.decimals) return null;

  const scaled = BigInt(whole) * 10n ** BigInt(info.decimals);
  const fracUnits = frac === "" ? 0n : BigInt(frac.padEnd(info.decimals, "0"));
  return (scaled + fracUnits).toString();
}

/** Sum a list of base-unit strings without going through `number`. */
export function sumBaseUnits(values: readonly (string | null | undefined)[]): string {
  let total = 0n;
  for (const v of values) {
    if (v == null || !/^-?[0-9]+$/.test(v)) continue;
    total += BigInt(v);
  }
  return total.toString();
}

/** A duration in ms as something a person reads: "24 hours", "5 minutes". */
export function humanMs(ms: number | null | undefined): string {
  const n = Number(ms ?? 0);
  if (!Number.isFinite(n) || n <= 0) return "—";
  const units: Array<[number, string]> = [
    [86_400_000, "day"],
    [3_600_000, "hour"],
    [60_000, "minute"],
    [1_000, "second"],
  ];
  for (const [size, name] of units) {
    if (n >= size) {
      const v = Math.round((n / size) * 10) / 10;
      return `${v} ${name}${v === 1 ? "" : "s"}`;
    }
  }
  return `${n} ms`;
}

/** Relative time, for "3 minutes ago" columns. */
export function ago(iso: string | null | undefined): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return String(iso);
  const diff = Date.now() - t;
  if (diff < 0) return "just now";
  return `${humanMs(diff)} ago`;
}

/** An ISO timestamp as a readable absolute time. */
export function when(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso) : d.toISOString().replace("T", " ").slice(0, 19);
}

/** Middle-truncate a long identifier: addresses, tx ids, uuids. */
export function midTrunc(s: string | null | undefined, keep = 10): string {
  const v = String(s ?? "");
  return v.length > keep * 2 ? `${v.slice(0, keep)}…${v.slice(-Math.floor(keep / 2))}` : v;
}
