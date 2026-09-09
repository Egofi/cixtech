import type { GatherStrategyKind } from "./attribution.js";

export interface FeeSweepLeg {
  address: string;
  derivationIndex: number;
  gatherStrategy: GatherStrategyKind;
  amountBaseUnits: bigint;
}

export interface FeeSweepPlan {
  tenant: string;
  merchant: string;
  chain: string;
  asset: string;

  claimBaseUnits: bigint;

  legs: FeeSweepLeg[];
  totalBaseUnits: bigint;

  skippedDust: number;
}

export interface FeeSweepPlannerOptions {
  dustThresholdBaseUnits?: bigint;
}

export interface GasStationConfig {
  nativeAsset: string;

  floorBaseUnits: bigint;
}

export interface GasFloatStatus {
  chain: string;
  balance: bigint;
  floor: bigint;
  healthy: boolean;
}
