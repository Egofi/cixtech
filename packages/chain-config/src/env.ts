/**
 * The single environment axis for the network switch (spec §16.5). testnet and
 * mainnet are separate DEPLOYMENTS with separate keys — this is never flipped in
 * a running process; it selects which config a deployment loads.
 */
import { InvalidEnvError } from "./errors.js";

export type ChainEnv = "testnet" | "mainnet";

export function chainEnv(): ChainEnv {
  const v = process.env["CHAIN_ENV"];
  if (v === "testnet" || v === "mainnet") return v;
  throw new InvalidEnvError(`CHAIN_ENV must be 'testnet' | 'mainnet', got: ${v ?? "undefined"}`);
}

/**
 * The same answer for callers that merely *display* the environment, where an
 * unset `CHAIN_ENV` is a missing label rather than a misconfiguration. Anything
 * that selects config or moves money must keep using `chainEnv()` and fail
 * closed — this exists so a console badge cannot 500 a data route.
 */
export function chainEnvOrNull(): ChainEnv | null {
  const v = process.env["CHAIN_ENV"];
  return v === "testnet" || v === "mainnet" ? v : null;
}
