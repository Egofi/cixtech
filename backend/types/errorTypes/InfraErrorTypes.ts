export const INFRA_ERROR_CODES = [
  "SIGNING_KEY_UNAVAILABLE",
  "DATABASE_NOT_CONFIGURED",
  "DATABASE_PLACEHOLDER_URL",
] as const;

export type InfraErrorCode = (typeof INFRA_ERROR_CODES)[number];
