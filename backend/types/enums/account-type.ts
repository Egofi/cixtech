export enum AccountType {
  Liability = "LIABILITY",
  Asset = "ASSET",
  Revenue = "REVENUE",
  Expense = "EXPENSE",
}

export type NormalSide = "DEBIT" | "CREDIT";

export const NORMAL_SIDE: Record<AccountType, NormalSide> = {
  [AccountType.Liability]: "CREDIT",
  [AccountType.Asset]: "DEBIT",
  [AccountType.Revenue]: "CREDIT",
  [AccountType.Expense]: "DEBIT",
};
