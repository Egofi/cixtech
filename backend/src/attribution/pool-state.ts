import { InvalidPoolTransitionError } from "@/common";
import type { PoolAction } from "@/types";

export enum PoolState {
  Available = "AVAILABLE",
  Reserved = "RESERVED",
  InUse = "IN_USE",
  Cooling = "COOLING",
}

const TRANSITIONS: Record<PoolAction, { from: PoolState[]; to: PoolState }> = {
  reserve: { from: [PoolState.Available], to: PoolState.Reserved },
  detect: { from: [PoolState.Reserved], to: PoolState.InUse },
  cool: { from: [PoolState.InUse], to: PoolState.Cooling },

  release: { from: [PoolState.Cooling, PoolState.Reserved], to: PoolState.Available },
};

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
