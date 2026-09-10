export * from "./common.js";
export * from "./ApiErrorTypes.js";
export * from "./AuthErrorTypes.js";
export * from "./ChainErrorTypes.js";
export * from "./ConfigErrorTypes.js";
export * from "./InfraErrorTypes.js";
export * from "./LedgerErrorTypes.js";
export * from "./MpcErrorTypes.js";
export * from "./PoolErrorTypes.js";

import { API_ERROR_CODES } from "./ApiErrorTypes.js";
import { AUTH_ERROR_CODES } from "./AuthErrorTypes.js";
import { CHAIN_ERROR_CODES } from "./ChainErrorTypes.js";
import { CONFIG_ERROR_CODES } from "./ConfigErrorTypes.js";
import { INFRA_ERROR_CODES } from "./InfraErrorTypes.js";
import { LEDGER_ERROR_CODES } from "./LedgerErrorTypes.js";
import { MPC_ERROR_CODES } from "./MpcErrorTypes.js";
import { POOL_ERROR_CODES } from "./PoolErrorTypes.js";

export const ERROR_CODES = [
  ...API_ERROR_CODES,
  ...AUTH_ERROR_CODES,
  ...CHAIN_ERROR_CODES,
  ...CONFIG_ERROR_CODES,
  ...INFRA_ERROR_CODES,
  ...LEDGER_ERROR_CODES,
  ...MPC_ERROR_CODES,
  ...POOL_ERROR_CODES,
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];
