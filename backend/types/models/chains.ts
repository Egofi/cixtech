export interface EvmAdapterConfig {
  chain: string;
  confirmations: number;

  tokenContracts: Record<string, string>;
}

export interface Eip1559Tx {
  chainId: bigint;
  nonce: bigint;
  maxPriorityFeePerGas: bigint;
  maxFeePerGas: bigint;
  gasLimit: bigint;

  to: string;
  value: bigint;
  data: Uint8Array;
}

export interface SignedTx {
  raw: string;

  hash: string;
}

export interface EvmLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  transactionHash: string;
  logIndex: string;
}

export interface EvmDepositSourceConfig {
  initialLookbackBlocks: number;
}

export interface EvmBroadcasterConfig {
  chainId: bigint;

  tokenContracts: Record<string, string>;

  nativeSymbol: string;
}

export type RlpInput = Uint8Array | bigint | RlpInput[];

export interface ChainDeposit {
  chain: string;
  txId: string;

  index: number;
  to: string;
  from: string;

  asset: string;

  tokenContract?: string;
  amountBaseUnits: bigint;
  blockNumber?: number;
}

export interface TronTransferIntent {
  ownerHex: string;

  toHex: string;
  amountBaseUnits: bigint;

  contractHex?: string | undefined;
}

export interface TronAdapterConfig {
  baseUrl: string;

  confirmations: number;

  apiKey?: string;
}

export interface WebhookEndpoint {
  url: string;
  secret: string;
}

export interface PoolGroup {
  tenant: string;
  merchant: string;
  chain: string;
  addresses: string[];
}

export interface ExternalDriftRow {
  tenant: string;
  merchant: string;
  chain: string;
  asset: string;

  ledger: bigint;

  onChain: bigint;
}

export interface ExternalReconResult {
  drift: ExternalDriftRow[];
  tripped: boolean;
}

export type IngestStatus = "credited" | "quarantined" | "duplicate" | "unmatched";

export type ReverseStatus = "reversed" | "not-found";

export interface IngestResult {
  status: IngestStatus;

  ref: string;
}

export interface SkippedChain {
  chain: string;
  reason: string;
}
