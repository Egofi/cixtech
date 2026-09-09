import type { Brand } from "./brand.js";

export type LedgerAccountKey = Brand<string, "LedgerAccountKey">;
export const LedgerAccountKey = (s: string): LedgerAccountKey => s as LedgerAccountKey;
