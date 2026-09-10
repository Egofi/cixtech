export interface AssetInfo {
  symbol: string;
  decimals: number;
  chains: string[];
  native: boolean;
}

let ASSETS: Record<string, AssetInfo> = {};

export function setAssets(list: readonly AssetInfo[] | undefined): void {
  const next: Record<string, AssetInfo> = {};
  for (const a of list ?? []) next[a.symbol.toUpperCase()] = a;
  ASSETS = next;
}

export function assetInfo(symbol: string | null | undefined): AssetInfo | null {
  return ASSETS[String(symbol ?? "").toUpperCase()] ?? null;
}

export function group(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export interface MoneyParts {
  text: string;

  raw: boolean;
}

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

export const money = (base: string | number | null | undefined, asset?: string): string =>
  moneyParts(base, asset).text;

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

export function sumBaseUnits(values: readonly (string | null | undefined)[]): string {
  let total = 0n;
  for (const v of values) {
    if (v == null || !/^-?[0-9]+$/.test(v)) continue;
    total += BigInt(v);
  }
  return total.toString();
}

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

export function ago(iso: string | null | undefined): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return String(iso);
  const diff = Date.now() - t;
  if (diff < 0) return "just now";
  return `${humanMs(diff)} ago`;
}

export function when(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso) : d.toISOString().replace("T", " ").slice(0, 19);
}

export function midTrunc(s: string | null | undefined, keep = 10): string {
  const v = String(s ?? "");
  return v.length > keep * 2 ? `${v.slice(0, keep)}…${v.slice(-Math.floor(keep / 2))}` : v;
}
