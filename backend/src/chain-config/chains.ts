import { ConfigNotFoundError } from "@/common";
import type { ChainConfig, ChainEnv } from "@/types";

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
    ETHEREUM: {
      chain: "ETHEREUM",
      family: "EVM",
      chainId: 11155111, // Sepolia
      rpcUrlEnvVar: "ETHEREUM_RPC_URL",
      finality: { confirmations: 64, note: "two epochs — PoS finality" },

      gas: { perTransferBaseUnits: 5_000_000_000_000_000n, nativeAsset: "ETH" },
    },
    AVALANCHE: {
      chain: "AVALANCHE",
      family: "EVM",
      chainId: 43113, // Fuji testnet
      rpcUrlEnvVar: "AVALANCHE_RPC_URL",
      finality: { confirmations: 12, note: "fast finality — buffer for RPC lag" },
      gas: { perTransferBaseUnits: 5_000_000_000_000_000n, nativeAsset: "AVAX" },
    },
    OPTIMISM: {
      chain: "OPTIMISM",
      family: "EVM",
      chainId: 11155420, // OP Sepolia
      rpcUrlEnvVar: "OPTIMISM_RPC_URL",
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
    ETHEREUM: {
      chain: "ETHEREUM",
      family: "EVM",
      chainId: 1,
      rpcUrlEnvVar: "ETHEREUM_RPC_URL",
      finality: { confirmations: 64, note: "two epochs — PoS finality" },
      gas: { perTransferBaseUnits: 5_000_000_000_000_000n, nativeAsset: "ETH" },
    },
    AVALANCHE: {
      chain: "AVALANCHE",
      family: "EVM",
      chainId: 43114,
      rpcUrlEnvVar: "AVALANCHE_RPC_URL",
      finality: { confirmations: 12, note: "fast finality — buffer for RPC lag" },
      gas: { perTransferBaseUnits: 5_000_000_000_000_000n, nativeAsset: "AVAX" },
    },
    OPTIMISM: {
      chain: "OPTIMISM",
      family: "EVM",
      chainId: 10,
      rpcUrlEnvVar: "OPTIMISM_RPC_URL",
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
