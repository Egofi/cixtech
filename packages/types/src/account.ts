import type { Brand } from "./brand.js";

export enum AccountType {
  Liability = "LIABILITY",
  Asset = "ASSET",
  Revenue = "REVENUE",
  Expense = "EXPENSE",
}

export type NormalSide = "DEBIT" | "CREDIT";

/**
 * The normal (increasing) side of each account type. A LIABILITY grows on the
 * credit side; an ASSET grows on the debit side. Used to interpret the signed
 * netted balance and to compute the solvency invariant (ADR 0010).
 */
export const NORMAL_SIDE: Record<AccountType, NormalSide> = {
  [AccountType.Liability]: "CREDIT",
  [AccountType.Asset]: "DEBIT",
  [AccountType.Revenue]: "CREDIT",
  [AccountType.Expense]: "DEBIT",
};

/**
 * Fully-qualified ledger account key, e.g. `merchant_available:{tenant}:{merchant}`,
 * `pool_addr:{chain}:{merchant}`, `egofi_fee_revenue:{tenant}`. Namespaced per
 * tenant so RLS + per-tenant trial balances hold (ADR 0010).
 */
export type LedgerAccountKey = Brand<string, "LedgerAccountKey">;
export const LedgerAccountKey = (s: string): LedgerAccountKey => s as LedgerAccountKey;
