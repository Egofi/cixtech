export interface AuthorizationClaims {
  intentId: string;
  tenant: string;
  merchant: string;
  chain: string;
  asset: string;

  amount: string;
  destination: string;

  sighash: string;
  policyVersion: string;

  approvals: readonly string[];

  decidedAt: number;

  expiresAt: number;
}

export interface AuthorizationToken {
  claims: AuthorizationClaims;

  signature: string;
}

export interface TransferIdentity {
  intentId: string;
  chain: string;
  asset: string;
  amount: string;
  destination: string;
  fromAddress: string;
}

export interface TronBroadcasterConfig {
  baseUrl: string;
  apiKey?: string;

  tokenContracts: Record<string, string>;

  feeLimitSun?: number;
}

export interface PayoutContext {
  tenant: string;
  merchant: string;
  chain: string;
  asset: string;
  amountBaseUnits: bigint;
  destination: string;

  requester?: string;

  approvals?: readonly string[];

  requestedAt?: Date;
}

export interface ApprovalPolicy {
  thresholdBaseUnits: bigint;
  required: number;
}

export interface TimeLockPolicy {
  thresholdBaseUnits: bigint;
  delayMs: number;
}

export type PolicyDecision =
  | { type: "ALLOW" }
  | { type: "DENY"; reason: string }
  | { type: "REQUIRE_APPROVAL"; needed: number; have: number }
  | { type: "HOLD"; reason: string }
  | { type: "DELAY"; until: Date };

export interface VelocityConfig {
  windowMs: number;

  maxTotalBaseUnits: bigint;
}

export type PayoutIntentStatus = "locked" | "broadcasting" | "broadcast" | "settled" | "failed";

export interface PayoutIntent {
  id: string;
  idempotencyKey: string;
  tenant: string;
  merchant: string;
  chain: string;
  asset: string;
  amountBaseUnits: bigint;
  destination: string;
  fromAddress: string | null;
  txId: string | null;
  status: PayoutIntentStatus;

  requestedBy: string | null;
  createdAt: Date;
}

export interface NewIntent {
  idempotencyKey: string;

  requestedBy?: string;
  tenant: string;
  merchant: string;
  chain: string;
  asset: string;
  amountBaseUnits: bigint;
  destination: string;
}

export interface PayoutRequest {
  chain: string;
  asset: string;
  amountBaseUnits: bigint;

  fromAddress: string;

  fromDerivationIndex: number;
  toAddress: string;

  idempotencyKey?: string;

  authorization?: AuthorizationToken;
}

export interface BroadcastResult {
  txId: string;
}
