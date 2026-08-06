export type GaapCategory = "ASSET" | "LIABILITY" | "EQUITY" | "REVENUE" | "EXPENSE";

export interface AccountMapping {
  accountCode: string; // Standard 4-digit GL code (e.g. 1000, 2000, 4000)
  glCode: string;
  accountName: string;
  category: GaapCategory;
  normalBalance: "DEBIT" | "CREDIT";
}

/**
 * Standard GAAP / IFRS Chart of Accounts mapping for CIXTech sub-ledger (US-ACC-02).
 */
export const GAAP_CHART_OF_ACCOUNTS: Record<string, AccountMapping> = {
  pool_addr: {
    accountCode: "1000",
    glCode: "1000",
    accountName: "Custody Pool Address Float",
    category: "ASSET",
    normalBalance: "DEBIT",
  },
  merchant_available: {
    accountCode: "2000",
    glCode: "2000",
    accountName: "Merchant Spendable Balance",
    category: "LIABILITY",
    normalBalance: "CREDIT",
  },
  merchant_pending_withdrawal: {
    accountCode: "2010",
    glCode: "2010",
    accountName: "Merchant Pending Payouts",
    category: "LIABILITY",
    normalBalance: "CREDIT",
  },
  compliance_suspense: {
    accountCode: "2020",
    glCode: "2020",
    accountName: "Compliance Suspense Reserve",
    category: "LIABILITY",
    normalBalance: "CREDIT",
  },
  egofi_fee_revenue: {
    accountCode: "4000",
    glCode: "4000",
    accountName: "Platform Fee Revenue",
    category: "REVENUE",
    normalBalance: "CREDIT",
  },
  treasury: {
    accountCode: "1010",
    glCode: "1010",
    accountName: "Platform Treasury Float",
    category: "ASSET",
    normalBalance: "DEBIT",
  },
  network_gas_expense: {
    accountCode: "5000",
    glCode: "5000",
    accountName: "On-Chain Network Gas Fees",
    category: "EXPENSE",
    normalBalance: "DEBIT",
  },
};

/**
 * Resolve GAAP Chart of Accounts mapping for a given internal ledger account key.
 */
export function resolveGaapMapping(accountKey: string): AccountMapping {
  const prefix = accountKey.split(":")[0] ?? accountKey;
  return (
    GAAP_CHART_OF_ACCOUNTS[prefix] ?? {
      accountCode: "9999",
      glCode: "9999",
      accountName: `Unclassified Account (${prefix})`,
      category: "ASSET",
      normalBalance: "DEBIT",
    }
  );
}
