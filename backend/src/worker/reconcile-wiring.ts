export interface ReconcileWiringInput {
  /** `CIXTECH_RECONCILE_CHAIN_BALANCES=true` — the operator asked for on-chain checks. */
  chainBalancesEnabled: boolean;

  /** A chain router was built, so there is something that can report on-chain balances. */
  hasChainRouter: boolean;
}

export interface ReconcileWiring {
  enabled: boolean;

  /** Why, in words an operator can act on. Shown at start-up. */
  reason: string;
}

/**
 * Whether external reconciliation may run.
 *
 * External reconciliation compares each ledger ASSET account against an on-chain
 * balance and trips the kill switch on any difference (ADR 0010) — which halts
 * every payout until a human resets it. That is the correct response to real
 * drift, and a catastrophic one to imaginary drift.
 *
 * So it runs only when a real chain balance source exists. The previous wiring
 * substituted a stub that reported `0n` for every address, which made every
 * credited deposit look like drift and froze all payouts one interval after the
 * first deposit. A reconciler with nothing to reconcile against is OFF; it never
 * answers from a placeholder.
 */
export function planExternalReconciliation(input: ReconcileWiringInput): ReconcileWiring {
  if (!input.hasChainRouter) {
    return {
      enabled: false,
      reason:
        "no chain router — external reconciliation needs <CHAIN>_RPC_URL and CIXTECH_ENGINE_XPRV",
    };
  }
  if (!input.chainBalancesEnabled) {
    return {
      enabled: false,
      reason: "set CIXTECH_RECONCILE_CHAIN_BALANCES=true to enable on-chain reconciliation",
    };
  }
  return { enabled: true, reason: "comparing the ledger against chain balances" };
}
