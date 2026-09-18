export type BaseUnits = string;

export type Timestamp = string;

export type Scope = "read" | "move-funds" | "approve";

export interface ApiError {
  error: {
    id?: string;
    code: string;
    message: string;
  };
}

export interface Account {
  id: string;
  externalRef: string | null;
  createdAt: Timestamp;
}

export interface Balance {
  accountId: string;
  asset: string;
  available: BaseUnits;
}

export interface DepositAddress {
  chain: string;
  address: string;
  state: string;
  cooldownUntil: Timestamp | null;
}

export interface Deposit {
  id: string;
  kind: string;
  occurredAt: Timestamp;
  asset: string;
  amount: BaseUnits;
  grossAmount: BaseUnits;
  feeCollected: BaseUnits;
  feeBps: number;
  feePercent: string;
  netCredited: BaseUnits;
  accountId: string | null;
}

export interface Payout {
  idempotencyKey: string;
  accountId: string;
  chain: string;
  asset: string;
  amount: BaseUnits;
  destination: string;
  status: string;
  txId: string | null;
  createdAt: Timestamp;
}

export interface AllowlistEntry {
  accountId: string;
  chain: string;
  address: string;
  usableAt: Timestamp;
  addedAt: Timestamp;
}

export interface WebhookDelivery {
  id: string;
  event: string;
  status: string;
  attempts: number;
  lastError: string | null;
  createdAt: Timestamp;
}

export interface ChainsResponse {
  chains: string[];
  env?: "testnet" | "mainnet";
  assets: Array<{
    symbol: string;
    decimals: number;
    chains: string[];
    native: boolean;
  }>;
}

export interface HeldWithdrawal {
  withdrawalId: string;
  status: "PENDING_APPROVAL" | "TIME_LOCKED";
  approvalsNeeded?: number;
  approvalsHave?: number;
  until?: Timestamp;
}

export interface TenantSummary {
  id: string;
  name: string;
  createdAt: Timestamp;
}

export interface ApiKeySummary {
  id: string;
  label: string | null;
  scopes: Scope[];
  createdAt: Timestamp;
  revokedAt: Timestamp | null;
  revokedReason: string | null;
}

export interface PoolAddressRow {
  address: string;
  tenant: string;
  merchant: string;
  chain: string;
  derivationIndex: number;
  state: string;
  gatherStrategy: string;
  cooldownUntil: Timestamp | null;
  /** Null means never read from the chain, which is not the same as zero. */
  balanceBaseUnits: BaseUnits | null;
  observedAt: Timestamp | null;
  lastError: string | null;
  /** On-chain minus ledger for this address's (chain, merchant) group. */
  groupDriftBaseUnits: BaseUnits;
}

export interface AuditRow {
  at: Timestamp;
  actor: string;
  action: string;
  target: string | null;
  result: "ok" | "error";
  detail: string | null;
  ip: string | null;
}

export interface KillSwitchState {
  engaged: boolean;
  reason?: string;
  since?: Timestamp;
}

declare global {
  interface Window {
    CIXTECH?: { apiBase?: string };
  }
}
