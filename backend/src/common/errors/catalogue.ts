import type { ErrorCode, ErrorPolicy } from "@/types";

const expected = (status: number): ErrorPolicy => ({
  status,
  severity: "expected",
  exposable: true,
  retryable: false,
});

const conflict = (status: number): ErrorPolicy => ({
  status,
  severity: "warning",
  exposable: true,
  retryable: false,
});

const transient = (status: number): ErrorPolicy => ({
  status,
  severity: "warning",
  exposable: false,
  retryable: true,
});

const internal = (status: number): ErrorPolicy => ({
  status,
  severity: "critical",
  exposable: false,
  retryable: false,
});

export const ERROR_CATALOGUE: Record<ErrorCode, ErrorPolicy> = {
  UNAUTHORIZED: expected(401),
  FORBIDDEN_SCOPE: expected(403),
  INVALID_SCOPES: expected(400),
  ACCOUNT_NOT_FOUND: expected(404),
  INVALID_DESTINATION: expected(400),
  UNSAFE_WEBHOOK_URL: expected(400),
  NOT_FOUND: expected(404),
  VALIDATION: expected(400),
  BAD_REQUEST: expected(400),
  RATE_LIMITED: { status: 429, severity: "expected", exposable: true, retryable: true },
  INTERNAL: internal(500),
  UNCLASSIFIED: internal(500),

  AUTH_FAILED: expected(401),
  ACCOUNT_LOCKED: expected(423),
  MFA_REQUIRED: expected(401),
  MFA_ENROLMENT_REQUIRED: expected(401),
  PRINCIPAL_EXISTS: conflict(409),
  PRINCIPAL_NOT_FOUND: expected(404),
  INVALID_ROLE: expected(400),
  NOT_AUTHENTICATED: expected(401),
  FORBIDDEN: expected(403),
  CSRF_FAILED: expected(403),
  PASSWORD_CHANGE_REQUIRED: expected(403),

  UNSUPPORTED_CHAIN: expected(400),
  CHAIN_MISCONFIGURED: internal(500),
  AUTHORIZATION_INVALID: { status: 403, severity: "critical", exposable: true, retryable: false },
  TRON_TX_MISMATCH: internal(500),
  POLICY_DENIED: expected(403),
  POLICY_APPROVAL_REQUIRED: expected(202),
  POLICY_TIME_LOCKED: expected(202),
  POLICY_COMPLIANCE_HOLD: expected(403),
  POLICY_SELF_APPROVAL: expected(403),
  WITHDRAWAL_NOT_FOUND: expected(404),
  FEE_TREASURY_NOT_CONFIGURED: {
    status: 400,
    severity: "warning",
    exposable: true,
    retryable: false,
  },
  SWEEP_HALTED: conflict(409),
  // A dry gas float stalls token payouts on that chain until it is topped up:
  // unavailable rather than invalid, worth paging on, and worth retrying.
  GAS_FLOAT_DEPLETED: { status: 503, severity: "critical", exposable: false, retryable: true },
  GAS_TREASURY_NOT_CONFIGURED: internal(500),

  CONFIG_NOT_FOUND: internal(500),
  CONFIG_INVALID_ENV: internal(500),

  SIGNING_KEY_UNAVAILABLE: { status: 503, severity: "critical", exposable: false, retryable: true },
  DATABASE_NOT_CONFIGURED: internal(500),
  DATABASE_PLACEHOLDER_URL: internal(500),

  LEDGER_INSUFFICIENT_FUNDS: conflict(409),
  LEDGER_UNKNOWN_ENTRY: conflict(409),
  LEDGER_UNBALANCED_ENTRY: internal(500),
  LEDGER_INVALID_POSTING: expected(400),
  LEDGER_DUPLICATE_ENTRY_ID: conflict(409),

  MPC_NODE_REJECTED: transient(502),
  MPC_THRESHOLD_NOT_MET: transient(503),
  MPC_BAD_CONTRIBUTION: { status: 502, severity: "critical", exposable: false, retryable: false },
  MPC_INTERIM_FORBIDDEN: expected(403),

  POOL_INSUFFICIENT_FUNDS: conflict(409),
  POOL_ADDRESS_NOT_FOUND: expected(404),
  POOL_CONCURRENT_MODIFICATION: {
    status: 409,
    severity: "warning",
    exposable: true,
    retryable: true,
  },
  POOL_INVALID_TRANSITION: conflict(409),
  GATHER_BUSY: { status: 409, severity: "expected", exposable: true, retryable: true },
  GATHER_STRATEGY_UNKNOWN: expected(400),
  GATHER_STRATEGY_NOT_SUPPORTED: expected(400),
};

export const UNCLASSIFIED_POLICY: ErrorPolicy = ERROR_CATALOGUE.UNCLASSIFIED;

export const policyFor = (code: ErrorCode): ErrorPolicy =>
  ERROR_CATALOGUE[code] ?? UNCLASSIFIED_POLICY;
