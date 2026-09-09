export const TENANT_ROUTES = {
  ACCOUNTS: "/v1/accounts",
  ACCOUNTS_BY_ID_ALLOWLIST: "/v1/accounts/:id/allowlist",
  ACCOUNTS_BY_ID_BALANCE: "/v1/accounts/:id/balance",
  ACCOUNTS_BY_ID_DEPOSIT_ADDRESSES: "/v1/accounts/:id/deposit-addresses",
  ACCOUNTS_BY_ID_WITHDRAWALS: "/v1/accounts/:id/withdrawals",
  AI_ANOMALIES: "/v1/ai/anomalies",
  AI_QUERY: "/v1/ai/query",
  AI_RULES: "/v1/ai/rules",
  ALLOWLIST: "/v1/allowlist",
  BALANCES: "/v1/balances",
  CHAINS: "/v1/chains",
  DEPOSITS: "/v1/deposits",
  PAYOUTS: "/v1/payouts",
  WEBHOOK: "/v1/webhook",
  WEBHOOK_DELIVERIES: "/v1/webhook/deliveries",
  WITHDRAWALS_BY_ID_APPROVE: "/v1/withdrawals/:id/approve",
} as const;

export type TenantRoutePath = (typeof TENANT_ROUTES)[keyof typeof TENANT_ROUTES];
