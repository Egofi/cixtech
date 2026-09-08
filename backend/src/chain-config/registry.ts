import { chainConfig, supportedChains } from "./chains.js";
import type { ChainConfig } from "./chains.js";
import { chainEnv } from "./env.js";
import type { ChainEnv } from "./env.js";
import { chainTokens, tokenConfig } from "./tokens.js";
import type { TokenConfig } from "./tokens.js";

/**
 * The one place the rest of the engine reads network config. Bound to a single
 * env at construction. Lookups are TOTAL for supported inputs and THROW on
 * anything else — never a silent default (§16.5). A missing config is a loud
 * failure, not a wrong-network transaction.
 */
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

  /** Every token this chain carries in this env — the set a deployment must resolve. */
  tokens(chain: string): readonly TokenConfig[] {
    return chainTokens(this.env, chain);
  }

  chains(): string[] {
    return supportedChains(this.env);
  }
}
