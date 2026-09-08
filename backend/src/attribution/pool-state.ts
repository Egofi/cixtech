import { AppError } from "@/errors";

/**
 * Deposit-address lifecycle (ADR 0009). Funds are never swept on a schedule — the
 * address holds its balance across states — so there is no SWEPT state. An
 * address returns to AVAILABLE only after cool-off, which spans deposit finality
 * AND the payment window closing + grace, to avoid mis-attributing a late payment
 * to the next invoice.
 *
 *   AVAILABLE → RESERVED → IN_USE → COOLING → AVAILABLE
 *                    └────────────────────────→ AVAILABLE   (invoice expired unpaid)
 */
export enum PoolState {
  Available = "AVAILABLE",
  Reserved = "RESERVED",
  InUse = "IN_USE",
  Cooling = "COOLING",
}

export type PoolAction = "reserve" | "detect" | "cool" | "release";

const TRANSITIONS: Record<PoolAction, { from: PoolState[]; to: PoolState }> = {
  reserve: { from: [PoolState.Available], to: PoolState.Reserved },
  detect: { from: [PoolState.Reserved], to: PoolState.InUse },
  cool: { from: [PoolState.InUse], to: PoolState.Cooling },
  // Cool-off elapsed, or an invoice expired before any payment arrived.
  release: { from: [PoolState.Cooling, PoolState.Reserved], to: PoolState.Available },
};

export class InvalidPoolTransitionError extends AppError {
  readonly code = "POOL_INVALID_TRANSITION";
}

export function nextPoolState(current: PoolState, action: PoolAction): PoolState {
  const t = TRANSITIONS[action];
  if (!t.from.includes(current)) {
    throw new InvalidPoolTransitionError(
      `Cannot ${action} a pool address in state ${current} (expected ${t.from.join(" | ")})`,
      { context: { current, action } },
    );
  }
  return t.to;
}

export function canPoolTransition(current: PoolState, action: PoolAction): boolean {
  return TRANSITIONS[action].from.includes(current);
}
