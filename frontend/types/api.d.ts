/**
 * The shapes the consoles consume from the cixtech API.
 *
 * The consoles are plain browser JavaScript with no build step, so nothing here
 * is compiled into the bundle — these declarations exist so the API contract is
 * written down on the frontend side of the boundary, and so an editor can offer
 * completion while working in `src/*.js`.
 *
 * That boundary is now a real one. The consoles used to be served by the API and
 * could be changed in the same commit as the endpoint they called; they are a
 * separately deployed artifact now, so a running console may be older or newer
 * than the API it is talking to. When you change one of these shapes, the two
 * deployments are briefly out of step by design — the field has to be added
 * before it is read, and read before it is removed.
 *
 * Amounts are ALWAYS integer base units as strings. Never a number: JavaScript
 * loses precision above 2^53, and a balance is the last place to discover that.
 * Divide by 10^decimals (from `GET /v1/chains`) only for display.
 */

/** Base units as a decimal string, e.g. "10000000" = 10 USDT at 6 decimals. */
export type BaseUnits = string;

/** ISO-8601 timestamp. */
export type Timestamp = string;

/** What a key is allowed to do. `approve` never implies `move-funds`. */
export type Scope = "read" | "move-funds" | "approve";

export interface ApiError {
  error: {
    /** Correlation id — quotable to support, joins to the server-side audit trail. */
    id?: string;
    code: string;
    message: string;
  };
}

// ── Tenant surface (/v1) ─────────────────────────────────────────────────────

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
  /** Pool lifecycle: AVAILABLE → RESERVED → IN_USE → COOLING → AVAILABLE. */
  state: string;
  cooldownUntil: Timestamp | null;
}

export interface Deposit {
  id: string;
  kind: string;
  occurredAt: Timestamp;
  asset: string;
  /** Net credited, except for a quarantined deposit where it is the gross. */
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
  /** A freshly added destination is unusable until this passes (§7.2 cool-down). */
  usableAt: Timestamp;
  addedAt: Timestamp;
}

export interface WebhookDelivery {
  id: string;
  event: string;
  status: string;
  attempts: number;
  /** Coarsened to a category server-side; never a raw connection error. */
  lastError: string | null;
  createdAt: Timestamp;
}

/** `GET /v1/chains` — decimals live here, and nowhere else on the client. */
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

/** A payout held by policy returns 202 rather than failing — the intent survives. */
export interface HeldWithdrawal {
  withdrawalId: string;
  status: "PENDING_APPROVAL" | "TIME_LOCKED";
  approvalsNeeded?: number;
  approvalsHave?: number;
  until?: Timestamp;
}

// ── Admin surface (/admin/api) ───────────────────────────────────────────────

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
  /** Null when never observed — which is NOT the same as a zero balance. */
  balance: BaseUnits | null;
  observedAt: Timestamp | null;
  lastError: string | null;
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

// ── Runtime configuration ────────────────────────────────────────────────────

declare global {
  interface Window {
    /**
     * Written by the container entrypoint from CIXTECH_API_BASE, so one built
     * image serves every environment. Empty means same-origin.
     */
    CIXTECH?: { apiBase?: string };
  }
}
