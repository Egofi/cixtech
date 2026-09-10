import type { Scope } from "../enums/scope.js";

export interface Tenant {
  id: string;
  name: string;

  keyId: string;
  scopes: readonly Scope[];
}

export interface Account {
  id: string;
  tenantId: string;
  externalRef: string | null;
}

export interface ApprovalRecord {
  approver: string;
  at: Date;
}

export interface MetricsOptions {
  token?: string | undefined;
}

export interface AppRole {
  name: string;

  password?: string;
  created: boolean;
}

export interface SchemaModule {
  name: string;
  sql: string;
}

export type SchemaStatus = "created" | "unchanged" | "changed";

export interface AppliedSchema {
  name: string;
  status: SchemaStatus;
}

export interface PolicyConfigReport {
  enforced: boolean;

  missing: string[];
}

export interface CookieOptions {
  crossSite: boolean;

  secure: boolean;

  domain?: string | undefined;
}

export interface RlsEffectiveness {
  role: string;

  bypasses: boolean;
  reason: string;
}

export interface StoredResponse {
  status: number;
  body: unknown;
}

export interface HostCheckOptions {
  requireResolvable?: boolean;
}

export interface WebhookUrlPolicy {
  allowInsecure?: boolean;
}

export interface MigrateOptions {
  createAppRole?: boolean;
  appRoleName?: string;
}

export interface AdminPlaneOptions {
  token?: string | undefined;
  limits?: { maxPerPayout: string; velocityWindowMs: number; velocityMax: string };

  feeTreasuryAddressFor?: ((chain: string) => string | undefined) | undefined;
}

export interface RateLimitOptions {
  max?: number;

  windowMs?: number;

  authFailureMax?: number;

  enabled?: boolean;
}

export interface FeeSweepResult {
  sweptCount: number;
  totalSweptAmount: string;
  asset: string;

  skipped: Array<{ merchant: string; chain: string; reason: string }>;
}

export interface AuditEntry {
  actor: string;
  action: string;
  target?: string | undefined;
  params?: Record<string, unknown> | undefined;
  result: "ok" | "error";
  detail?: string | undefined;
  ip?: string | undefined;
}

export interface AssetPosition {
  asset: string;
  assets: string;
  liabilities: string;
  solvent: boolean;
}

export interface PayoutParams {
  tenant: string;
  merchant: string;
  chain: string;
  asset: string;
  amountBaseUnits: bigint;
  destination: string;

  idempotencyKey: string;

  requester?: string;

  approvals?: readonly string[];
}

export interface PayoutLeg {
  address: string;
  txId: string;
  amountBaseUnits: bigint;
}

export interface PayoutResult {
  txId: string;
  status: "settled";

  from: string;

  legs?: PayoutLeg[];
}
