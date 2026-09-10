import { InvalidEnvError } from "@/common";
import type { ChainEnv } from "@/types";

export function chainEnv(): ChainEnv {
  const v = process.env["CHAIN_ENV"];
  if (v === "testnet" || v === "mainnet") return v;
  throw new InvalidEnvError(`CHAIN_ENV must be 'testnet' | 'mainnet', got: ${v ?? "undefined"}`);
}

export function chainEnvOrNull(): ChainEnv | null {
  const v = process.env["CHAIN_ENV"];
  return v === "testnet" || v === "mainnet" ? v : null;
}
