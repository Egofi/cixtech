import type { ChainEnv } from "./env.js";
import { ConfigNotFoundError } from "./errors.js";

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
/** USDC + USDT (both 6-decimal) and the native gas token (18-decimal) for one EVM chain. */
function evmTokens(chain: string, nativeSymbol: string): Record<string, TokenConfig> {
  return {
    USDC: { symbol: "USDC", chain, decimals: 6, contractAddressEnvVar: `${chain}_USDC_ADDRESS` },
    USDT: { symbol: "USDT", chain, decimals: 6, contractAddressEnvVar: `${chain}_USDT_ADDRESS` },
    [nativeSymbol]: {
      symbol: nativeSymbol,
      chain,
      decimals: 18,
      contractAddressEnvVar: "",
      native: true,
    },
  };
}

const TRON_TOKENS: Record<string, TokenConfig> = {
  USDT: { symbol: "USDT", chain: "TRON", decimals: 6, contractAddressEnvVar: "TRON_USDT_ADDRESS" },
  TRX: { symbol: "TRX", chain: "TRON", decimals: 6, contractAddressEnvVar: "", native: true },
};

// EVM chains share one token shape across envs; only the resolved addresses differ (§16.5).
const EVM_TOKENS: Record<string, Record<string, TokenConfig>> = {
  POLYGON: evmTokens("POLYGON", "POL"),
  BSC: evmTokens("BSC", "BNB"),
  ARBITRUM: evmTokens("ARBITRUM", "ETH"),
  BASE: evmTokens("BASE", "ETH"),
};

const TOKENS: Record<ChainEnv, Record<string, Record<string, TokenConfig>>> = {
  testnet: { TRON: TRON_TOKENS, ...EVM_TOKENS },
  mainnet: { TRON: TRON_TOKENS, ...EVM_TOKENS },
};

export function tokenConfig(env: ChainEnv, chain: string, symbol: string): TokenConfig {
  const cfg = TOKENS[env][chain.toUpperCase()]?.[symbol.toUpperCase()];
  if (!cfg) throw new ConfigNotFoundError(`No token config for ${symbol} on ${chain}/${env}`);
  return cfg;
}
