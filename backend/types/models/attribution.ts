export interface GatheredSource {
  address: string;
  derivationIndex: number;

  gatherStrategy: GatherStrategyKind;
}

export interface GatheredLeg extends GatheredSource {
  amountBaseUnits: bigint;
}

export interface GatherConfigRow {
  chain: string;

  tenant: string;
  activeStrategy: GatherStrategyKind;
  updatedBy: string;
  approvedBy: string;
  effectiveAt: Date;
}

export interface NewPoolAddress {
  tenant: string;
  merchant: string;
  chain: string;
  derivationIndex: number;
  address: string;
  invoiceId: string;
  gatherStrategy: GatherStrategyKind;
}

export interface StateChange {
  invoiceId?: string | null;
  cooldownUntil?: Date | null;
}

export type PoolAction = "reserve" | "detect" | "cool" | "release";

export type GatherStrategyKind = "EOA_FUND_TRANSFER" | "FORWARDER" | "EIP7702";

export interface GatherPreparation {
  fundedNativeBaseUnits: bigint;
}

export interface PrepareGatherInput {
  chain: string;

  address: string;

  derivationIndex: number;
  asset: string;
  amountBaseUnits: bigint;

  idempotencyKey: string;
}

export interface CachedBalance {
  chain: string;
  address: string;
  asset: string;
  balanceBaseUnits: bigint;
  observedAt: Date;
  source: string;
  lastError: string | null;
}

export interface BalanceTarget {
  chain: string;
  address: string;
  asset: string;
}

export interface RefreshSummary {
  observed: number;
  failed: number;
}

export interface AttributionEntry {
  tenant: string;
  merchant: string;
  feeBasisPoints: number;
}
