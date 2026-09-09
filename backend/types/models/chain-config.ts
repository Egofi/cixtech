export type ChainFamily = "EVM" | "UTXO" | "TRON" | "XRP";

export interface FinalityRule {
  readonly confirmations: number;
  readonly note?: string;
}

export interface GasRule {
  readonly perTransferBaseUnits: bigint;

  readonly nativeAsset: string;
}

export interface ChainConfig {
  readonly chain: string;
  readonly family: ChainFamily;

  readonly chainId?: number;
  readonly rpcUrlEnvVar: string;
  readonly finality: FinalityRule;

  readonly gas: GasRule;
}

export type ChainEnv = "testnet" | "mainnet";

export interface TokenConfig {
  readonly symbol: string;
  readonly chain: string;
  readonly decimals: number;

  readonly contractAddressEnvVar: string;

  readonly native?: boolean;
}

export interface AssetInfo {
  readonly symbol: string;

  readonly decimals: number;
  readonly chains: readonly string[];
  readonly native: boolean;
}
