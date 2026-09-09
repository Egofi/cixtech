import { AccountType, type LedgerAccountKey, NORMAL_SIDE } from "@/types";

export function accountTypeOf(key: LedgerAccountKey): AccountType {
  const prefix = String(key).split(":", 1)[0] ?? "";
  if (prefix.startsWith("merchant_") || prefix === "compliance_suspense") {
    return AccountType.Liability;
  }

  if (prefix.startsWith("pool_addr") || ["treasury", "cold", "gas_float"].includes(prefix)) {
    return AccountType.Asset;
  }
  if (prefix.endsWith("_revenue")) return AccountType.Revenue;
  if (prefix.endsWith("_expense")) return AccountType.Expense;
  throw new Error(`Unknown account key prefix: ${prefix}`);
}

export function normalBalance(key: LedgerAccountKey, signedNetDebitPositive: bigint): bigint {
  return NORMAL_SIDE[accountTypeOf(key)] === "DEBIT"
    ? signedNetDebitPositive
    : -signedNetDebitPositive;
}
