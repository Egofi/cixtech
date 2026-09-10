export const CONFIG_ERROR_CODES = ["CONFIG_NOT_FOUND", "CONFIG_INVALID_ENV"] as const;

export type ConfigErrorCode = (typeof CONFIG_ERROR_CODES)[number];
