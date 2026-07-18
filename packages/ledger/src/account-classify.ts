import { AccountType, type LedgerAccountKey, NORMAL_SIDE } from "@cixtech/types";

/**
 * Classifies a ledger account by its key prefix. The taxonomy has ONE home here
 * (not in an adapter) so the store, the solvency check, and balance-guards all
 * agree. `merchant_available:t:m` → LIABILITY, `pool_addr:chain:m` → ASSET, etc.
 */
export function accountTypeOf(key: LedgerAccountKey): AccountType {
  const prefix = String(key).split(":", 1)[0] ?? "";
  if (prefix.startsWith("merchant_") || prefix === "compliance_suspense") {
    return AccountType.Liability;
  }
  if (["pool_addr", "treasury", "cold", "gas_float"].includes(prefix)) return AccountType.Asset;
  if (prefix.endsWith("_revenue")) return AccountType.Revenue;
  if (prefix.endsWith("_expense")) return AccountType.Expense;
  throw new Error(`Unknown account key prefix: ${prefix}`);
}

/**
 * Converts a raw signed net (DEBIT positive) into the balance on the account's
 * OWN normal side — i.e. the intuitive positive magnitude. A merchant liability
 * with 100 credited reads as +100 "owed", not −100. Guards and reports use this
 * so they never reason about raw signs.
 */
export function normalBalance(key: LedgerAccountKey, signedNetDebitPositive: bigint): bigint {
  return NORMAL_SIDE[accountTypeOf(key)] === "DEBIT"
    ? signedNetDebitPositive
    : -signedNetDebitPositive;
}
