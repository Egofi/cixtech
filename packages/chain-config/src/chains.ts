import type { ChainEnv } from "./env.js";

export type ChainFamily = "EVM" | "UTXO" | "TRON" | "XRP";

export interface FinalityRule {
  /** Confirmations before a deposit is credited. Scaled up for high value (§9). */
  readonly confirmations: number;
  readonly note?: string;
}

export interface ChainConfig {
  readonly chain: string;
  readonly family: ChainFamily;
  /** Numeric chain id where meaningful (EVM). Undefined for non-EVM. */
  readonly chainId?: number;
  readonly rpcUrlEnvVar: string; // the NAME of the env var, never the URL literal
  readonly finality: FinalityRule;
}

/**
 * Per-(chain, env) config. Only chains with a real entry are supported; the
 * registry throws on anything else rather than guessing (§16.5).
 *
 * NOTE: rpc endpoints are referenced by env-var NAME, never inlined — the
 * no-magic-constants guard forbids URL/address literals outside... nothing:
 * they live in the deployment env, not the repo.
 *
 * TODO(step1): fill BSC, ARBITRUM, BASE, POLYGON, BTC, LTC, XRP for both envs.
 */
const CHAINS: Record<ChainEnv, Record<string, ChainConfig>> = {
  testnet: {
    TRON: {
      chain: "TRON",
      family: "TRON",
      rpcUrlEnvVar: "TRON_RPC_URL",
      finality: { confirmations: 19, note: "solidified block (Nile testnet)" },
    },
    POLYGON: {
      chain: "POLYGON",
      family: "EVM",
      chainId: 80002, // Amoy testnet
      rpcUrlEnvVar: "POLYGON_RPC_URL",
      finality: { confirmations: 50, note: "deep — reorg history" },
    },
  },
  mainnet: {
    TRON: {
      chain: "TRON",
      family: "TRON",
      rpcUrlEnvVar: "TRON_RPC_URL",
      finality: { confirmations: 19, note: "solidified block" },
    },
    POLYGON: {
      chain: "POLYGON",
      family: "EVM",
      chainId: 137,
      rpcUrlEnvVar: "POLYGON_RPC_URL",
      finality: { confirmations: 128, note: "deep — reorg history" },
    },
  },
};

export function chainConfig(env: ChainEnv, chain: string): ChainConfig {
  const cfg = CHAINS[env][chain.toUpperCase()];
  if (!cfg) throw new Error(`No chain config for ${chain} on ${env}`);
  return cfg;
}

export function supportedChains(env: ChainEnv): string[] {
  return Object.keys(CHAINS[env]);
}
