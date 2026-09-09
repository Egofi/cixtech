export const MPC_ERROR_CODES = [
  "MPC_NODE_REJECTED",
  "MPC_THRESHOLD_NOT_MET",
  "MPC_BAD_CONTRIBUTION",
  "MPC_INTERIM_FORBIDDEN",
] as const;

export type MpcErrorCode = (typeof MPC_ERROR_CODES)[number];
