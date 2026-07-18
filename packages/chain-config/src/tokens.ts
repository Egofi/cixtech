import type { ChainEnv } from "./env.js";

export interface TokenConfig {
  readonly symbol: string;
  readonly chain: string;
  readonly decimals: number;
  /** Contract address per (chain, env). testnet USDT != mainnet USDT (§16.5). */
  readonly contractAddressEnvVar: string; // env-var NAME — address is never a repo literal
  /** Native gas token (e.g. TRX on TRON) has no contract. */
  readonly native?: boolean;
}

/**
 * Token registry keyed by (env, chain, symbol). The whole reason it exists:
 * testnet USDT and mainnet USDT are DIFFERENT contracts on every chain, so a
 * token address must never be a literal in code — it resolves from here + env.
 *
 * TODO(step1): complete the token set per supported (chain, env).
 */
const TOKENS: Record<ChainEnv, Record<string, Record<string, TokenConfig>>> = {
  testnet: {
    TRON: {
      USDT: {
        symbol: "USDT",
        chain: "TRON",
        decimals: 6,
        contractAddressEnvVar: "TRON_USDT_ADDRESS",
      },
      TRX: { symbol: "TRX", chain: "TRON", decimals: 6, contractAddressEnvVar: "", native: true },
    },
  },
  mainnet: {
    TRON: {
      USDT: {
        symbol: "USDT",
        chain: "TRON",
        decimals: 6,
        contractAddressEnvVar: "TRON_USDT_ADDRESS",
      },
      TRX: { symbol: "TRX", chain: "TRON", decimals: 6, contractAddressEnvVar: "", native: true },
    },
  },
};

export function tokenConfig(env: ChainEnv, chain: string, symbol: string): TokenConfig {
  const cfg = TOKENS[env][chain.toUpperCase()]?.[symbol.toUpperCase()];
  if (!cfg) throw new Error(`No token config for ${symbol} on ${chain}/${env}`);
  return cfg;
}
