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

/** Every token configured for one chain in this env. */
export function chainTokens(env: ChainEnv, chain: string): readonly TokenConfig[] {
  return Object.values(TOKENS[env][chain.toUpperCase()] ?? {});
}

/** A symbol as the API presents it: what it is worth, and where it can be held. */
export interface AssetInfo {
  readonly symbol: string;
  /** Base-unit exponent. A UI MUST divide by 10^decimals before showing an amount. */
  readonly decimals: number;
  readonly chains: readonly string[];
  readonly native: boolean;
}

/**
 * Every asset symbol in this env, with the decimals a display layer needs.
 *
 * The ledger stores integer base units, so a UI that prints them raw is off by
 * 10^decimals — it reads 4.34 USDT as 4,340,000. Decimals live here and nowhere
 * else (§16.5), so this is what the API hands out rather than letting each client
 * carry its own table.
 *
 * Keyed by symbol, not (chain, symbol): a symbol that meant different things on
 * different chains would make an amount ambiguous wherever the ledger records the
 * asset without a chain (`merchant_available:…` postings do exactly that). Rather
 * than display a guess, a disagreement throws here — loudly, at boot.
 */
export function assetRegistry(env?: ChainEnv): readonly AssetInfo[] {
  if (env) return registryFor(env);
  // No env given. Decimals are a property of the TOKEN, not of the network it is
  // deployed on — per (chain, env) only the contract ADDRESS differs (§16.5). So a
  // display layer should not have to make CHAIN_ENV a boot requirement just to
  // render a number. Verify that invariant across every env rather than assume it.
  const envs = Object.keys(TOKENS) as ChainEnv[];
  const first = registryFor(envs[0] as ChainEnv);
  for (const other of envs.slice(1)) {
    if (JSON.stringify(registryFor(other)) !== JSON.stringify(first)) {
      throw new ConfigNotFoundError(
        `Asset decimals differ between ${envs[0]} and ${other}. Pass an explicit env to assetRegistry(); a display layer can no longer be env-agnostic.`,
      );
    }
  }
  return first;
}

function registryFor(env: ChainEnv): readonly AssetInfo[] {
  const bySymbol = new Map<string, { decimals: number; chains: string[]; native: boolean }>();
  for (const [chain, tokens] of Object.entries(TOKENS[env])) {
    for (const token of Object.values(tokens)) {
      const seen = bySymbol.get(token.symbol);
      if (!seen) {
        bySymbol.set(token.symbol, {
          decimals: token.decimals,
          chains: [chain],
          native: token.native === true,
        });
        continue;
      }
      if (seen.decimals !== token.decimals) {
        const where = seen.chains.join("/");
        throw new ConfigNotFoundError(
          `${token.symbol} is ${seen.decimals}-decimal on ${where} but ${token.decimals}-decimal on ${chain}. One symbol cannot mean two amounts — give the tokens distinct symbols, or teach the API to key assets by (chain, symbol).`,
        );
      }
      seen.chains.push(chain);
    }
  }
  return [...bySymbol.entries()]
    .map(([symbol, v]) => ({
      symbol,
      decimals: v.decimals,
      chains: [...v.chains].sort(),
      native: v.native,
    }))
    .sort((a, b) => a.symbol.localeCompare(b.symbol));
}
