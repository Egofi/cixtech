import type { ConfigErrorCode } from "@/types";
import { AppError } from "./AppException.js";

export abstract class ConfigException extends AppError {
  abstract override readonly code: ConfigErrorCode;
}

export class ConfigNotFoundError extends ConfigException {
  readonly code = "CONFIG_NOT_FOUND";
}

export class InvalidEnvError extends ConfigException {
  readonly code = "CONFIG_INVALID_ENV";
}
