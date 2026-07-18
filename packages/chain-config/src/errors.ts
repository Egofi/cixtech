import { AppError } from "@cixtech/errors";

/** A (chain, env[, symbol]) lookup missed — a loud failure, never a silent default (§16.5). */
export class ConfigNotFoundError extends AppError {
  readonly code = "CONFIG_NOT_FOUND";
}

/** CHAIN_ENV was absent or not one of testnet | mainnet. */
export class InvalidEnvError extends AppError {
  readonly code = "CONFIG_INVALID_ENV";
}
