import type { ChainEnv } from "./env.js";
import { ConfigNotFoundError } from "./errors.js";

export type ChainFamily = "EVM" | "UTXO" | "TRON" | "XRP";

export interface FinalityRule {
  /** Confirmations before a deposit is credited. Scaled up for high value (§9). */
  readonly confirmations: number;
  readonly note?: string;
}

export interface GasRule {
  /**
   * Native base units a pool address must hold before it can send ONE token
   * transfer (build spec §6.2). Zero on families whose fee comes out of the
   * transfer itself (UTXO), non-zero wherever the sender pays gas from its own
   * balance — EVM ERC-20 and Tron TRC-20 both do, and a pool address that only
   * ever received USDC has none of it.
   */
  readonly perTransferBaseUnits: bigint;
  /** The chain's native gas asset symbol. */
  readonly nativeAsset: string;
}

export interface ChainConfig {
  readonly chain: string;
  readonly family: ChainFamily;
  /** Numeric chain id where meaningful (EVM). Undefined for non-EVM. */
  readonly chainId?: number;
  readonly rpcUrlEnvVar: string; // the NAME of the env var, never the URL literal
  readonly finality: FinalityRule;
  /** What a token payout out of a pool address costs to send. */
  readonly gas: GasRule;
}

/**
 * Per-(chain, env) config. Only chains with a real entry are supported; the
 * registry throws on anything else rather than guessing (§16.5).
 *
 * NOTE: rpc endpoints are referenced by env-var NAME, never inlined — the
 * no-magic-constants guard forbids URL/address literals outside... nothing:
 * they live in the deployment env, not the repo.
 *
 * TODO: fill BTC, LTC, XRP for both envs (EVM family — POLYGON, BSC, ARBITRUM,
 * BASE — is complete).
 */
const CHAINS: Record<ChainEnv, Record<string, ChainConfig>> = {
  testnet: {
    TRON: {
      chain: "TRON",
      family: "TRON",
      rpcUrlEnvVar: "TRON_RPC_URL",
      finality: { confirmations: 19, note: "solidified block (Nile testnet)" },
      gas: { perTransferBaseUnits: 30_000_000n, nativeAsset: "TRX" },
    },
    POLYGON: {
      chain: "POLYGON",
      family: "EVM",
      chainId: 80002, // Amoy testnet
      rpcUrlEnvVar: "POLYGON_RPC_URL",
      finality: { confirmations: 50, note: "deep — reorg history" },
      gas: { perTransferBaseUnits: 10_000_000_000_000_000n, nativeAsset: "POL" },
    },
    BSC: {
      chain: "BSC",
      family: "EVM",
      chainId: 97, // BSC testnet
      rpcUrlEnvVar: "BSC_RPC_URL",
      finality: { confirmations: 15, note: "fast blocks" },
      gas: { perTransferBaseUnits: 2_000_000_000_000_000n, nativeAsset: "BNB" },
    },
    ARBITRUM: {
      chain: "ARBITRUM",
      family: "EVM",
      chainId: 421614, // Arbitrum Sepolia
      rpcUrlEnvVar: "ARBITRUM_RPC_URL",
      finality: { confirmations: 20, note: "L2 — true finality follows L1" },
      gas: { perTransferBaseUnits: 1_000_000_000_000_000n, nativeAsset: "ETH" },
    },
    BASE: {
      chain: "BASE",
      family: "EVM",
      chainId: 84532, // Base Sepolia
      rpcUrlEnvVar: "BASE_RPC_URL",
      finality: { confirmations: 20, note: "L2 — true finality follows L1" },
      gas: { perTransferBaseUnits: 1_000_000_000_000_000n, nativeAsset: "ETH" },
    },
  },
  mainnet: {
    TRON: {
      chain: "TRON",
      family: "TRON",
      rpcUrlEnvVar: "TRON_RPC_URL",
      finality: { confirmations: 19, note: "solidified block" },
      gas: { perTransferBaseUnits: 30_000_000n, nativeAsset: "TRX" },
    },
    POLYGON: {
      chain: "POLYGON",
      family: "EVM",
      chainId: 137,
      rpcUrlEnvVar: "POLYGON_RPC_URL",
      finality: { confirmations: 128, note: "deep — reorg history" },
      gas: { perTransferBaseUnits: 10_000_000_000_000_000n, nativeAsset: "POL" },
    },
    BSC: {
      chain: "BSC",
      family: "EVM",
      chainId: 56,
      rpcUrlEnvVar: "BSC_RPC_URL",
      finality: { confirmations: 15, note: "fast blocks" },
      gas: { perTransferBaseUnits: 2_000_000_000_000_000n, nativeAsset: "BNB" },
    },
    ARBITRUM: {
      chain: "ARBITRUM",
      family: "EVM",
      chainId: 42161,
      rpcUrlEnvVar: "ARBITRUM_RPC_URL",
      finality: { confirmations: 20, note: "L2 — true finality follows L1" },
      gas: { perTransferBaseUnits: 1_000_000_000_000_000n, nativeAsset: "ETH" },
    },
    BASE: {
      chain: "BASE",
      family: "EVM",
      chainId: 8453,
      rpcUrlEnvVar: "BASE_RPC_URL",
      finality: { confirmations: 20, note: "L2 — true finality follows L1" },
      gas: { perTransferBaseUnits: 1_000_000_000_000_000n, nativeAsset: "ETH" },
    },
  },
};

export function chainConfig(env: ChainEnv, chain: string): ChainConfig {
  const cfg = CHAINS[env][chain.toUpperCase()];
  if (!cfg) throw new ConfigNotFoundError(`No chain config for ${chain} on ${env}`);
  return cfg;
}

export function supportedChains(env: ChainEnv): string[] {
  return Object.keys(CHAINS[env]);
}
