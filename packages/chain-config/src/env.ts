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
