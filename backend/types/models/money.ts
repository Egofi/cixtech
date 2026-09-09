import type { Brand } from "./brand.js";

export type AmountBaseUnits = bigint;

export type Asset = Brand<string, "Asset">;
export const Asset = (s: string): Asset => s.toUpperCase() as Asset;

export type Chain = Brand<string, "Chain">;
export const Chain = (s: string): Chain => s.toUpperCase() as Chain;
