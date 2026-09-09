import type { ChainConfig, ChainEnv, TokenConfig } from "@/types";
import { chainConfig, supportedChains } from "./chains.js";

import { chainEnv } from "./env.js";

import { chainTokens, tokenConfig } from "./tokens.js";

export class ChainRegistry {
  constructor(private readonly env: ChainEnv = chainEnv()) {}

  get environment(): ChainEnv {
    return this.env;
  }

  chain(chain: string): ChainConfig {
    return chainConfig(this.env, chain);
  }

  token(chain: string, symbol: string): TokenConfig {
    return tokenConfig(this.env, chain, symbol);
  }

  tokens(chain: string): readonly TokenConfig[] {
    return chainTokens(this.env, chain);
  }

  chains(): string[] {
    return supportedChains(this.env);
  }
}
