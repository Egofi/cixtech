import type { Brand } from "./brand.js";

/**
 * On-chain amounts are integer base units (e.g. USDT-TRC20 has 6 decimals, so
 * 1 USDT = 1_000_000n). Never a float, never a Number (spec principle 4).
 */
export type AmountBaseUnits = bigint;

/** Base token symbol, e.g. "USDT", "TRX". Chain is tracked separately. */
export type Asset = Brand<string, "Asset">;
export const Asset = (s: string): Asset => s.toUpperCase() as Asset;

/** Chain identifier used across the engine, e.g. "TRON", "POLYGON". */
export type Chain = Brand<string, "Chain">;
export const Chain = (s: string): Chain => s.toUpperCase() as Chain;
