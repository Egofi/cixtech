import { ConfigNotFoundError } from "@/common";
import type { AssetInfo, ChainEnv, TokenConfig } from "@/types";

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

const EVM_TOKENS: Record<string, Record<string, TokenConfig>> = {
  POLYGON: evmTokens("POLYGON", "POL"),
  BSC: evmTokens("BSC", "BNB"),
  ARBITRUM: evmTokens("ARBITRUM", "ETH"),
  BASE: evmTokens("BASE", "ETH"),
  ETHEREUM: evmTokens("ETHEREUM", "ETH"),
  AVALANCHE: evmTokens("AVALANCHE", "AVAX"),
  OPTIMISM: evmTokens("OPTIMISM", "ETH"),
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

export function chainTokens(env: ChainEnv, chain: string): readonly TokenConfig[] {
  return Object.values(TOKENS[env][chain.toUpperCase()] ?? {});
}

export function assetRegistry(env?: ChainEnv): readonly AssetInfo[] {
  if (env) return registryFor(env);

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
