import type { LedgerService } from "@cixtech/ledger";
import { Asset, LedgerAccountKey } from "@cixtech/types";
import type { ReconcilerBreaker } from "../reconcile/external-reconciler.js";

/**
 * Provisions native gas so an EVM/Tron pool address can actually send its ERC-20 /
 * TRC-20 payout (build spec §6.2). ERC-20 sweeps need native gas IN the address;
 * without this the transfer silently fails. Behind a port so the funding mechanism
 * (fund-then-transfer, a relayer, staked Tron energy) is swappable per chain.
 */
export interface GasFunder {
  /**
   * Ensure `address` holds at least `minNativeBaseUnits` of native gas to send one
   * transfer. Returns the amount topped up (0 if already sufficient). Idempotent on
   * `idempotencyKey` so a retried gather never double-funds.
   */
  fund(input: {
    chain: string;
    address: string;
    minNativeBaseUnits: bigint;
    idempotencyKey: string;
  }): Promise<{ funded: bigint }>;
}

export interface GasStationConfig {
  /** The native gas asset symbol for the chain (e.g. "MATIC", "BNB", "TRX", "ETH"). */
  nativeAsset: string;
  /** Below this `gas_float:{chain}` balance, the chain's payouts are frozen (§6.2). */
  floorBaseUnits: bigint;
}

export interface GasFloatStatus {
  chain: string;
  balance: bigint;
  floor: bigint;
  healthy: boolean;
}

/**
 * Monitors the first-class `gas_float:{chain}` ASSET account and provisions gas for
 * payout gathers (build spec §6.2). If the float runs below its floor, payouts on
 * that chain would stall silently — so depletion TRIPS the circuit breaker
 * (per-chain kill-switch) instead, failing closed and paging a human. It reports
 * float health and, via the injected `GasFunder`, tops addresses up before a gather.
 */
export class GasStation {
  constructor(
    private readonly ledger: LedgerService,
    private readonly configs: ReadonlyMap<string, GasStationConfig>,
    private readonly funder?: GasFunder,
    private readonly breaker?: ReconcilerBreaker,
  ) {}

  private configFor(chain: string): GasStationConfig {
    const c = this.configs.get(chain);
    if (!c) throw new Error(`No gas-station config for chain ${chain}`);
    return c;
  }

  /** Current `gas_float:{chain}` balance vs. its floor. */
  async floatStatus(chain: string): Promise<GasFloatStatus> {
    const c = this.configFor(chain);
    const balance = await this.ledger.getBalance(
      LedgerAccountKey(`gas_float:${chain}`),
      Asset(c.nativeAsset),
    );
    return { chain, balance, floor: c.floorBaseUnits, healthy: balance >= c.floorBaseUnits };
  }

  /**
   * Check every configured chain's float; trip the breaker for any that is below
   * floor (§6.2 "trip the circuit breaker on depletion"). Returns each status.
   */
  async monitor(): Promise<GasFloatStatus[]> {
    const statuses: GasFloatStatus[] = [];
    for (const chain of this.configs.keys()) {
      const status = await this.floatStatus(chain);
      statuses.push(status);
      if (!status.healthy && this.breaker) {
        await this.breaker.trip(
          `gas_float:${chain} depleted: ${status.balance} < floor ${status.floor}`,
        );
      }
    }
    return statuses;
  }

  /**
   * Provision native gas for a pool address before a gather, failing closed if the
   * float is below floor (never drain the last of the float and strand a payout
   * mid-flight). Requires a configured `GasFunder`.
   */
  async provision(input: {
    chain: string;
    address: string;
    minNativeBaseUnits: bigint;
    idempotencyKey: string;
  }): Promise<{ funded: bigint }> {
    if (!this.funder) throw new Error("GasStation has no funder configured");
    const status = await this.floatStatus(input.chain);
    if (!status.healthy) {
      if (this.breaker) {
        await this.breaker.trip(`gas_float:${input.chain} below floor; refusing to provision gas`);
      }
      throw new Error(`gas_float:${input.chain} below floor — payouts frozen`);
    }
    return this.funder.fund(input);
  }
}
