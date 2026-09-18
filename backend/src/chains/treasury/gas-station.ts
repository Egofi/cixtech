import type { AddressBalance } from "@/attribution";
import { GasFloatDepletedError, GasTreasuryNotConfiguredError } from "@/common";
import type { LedgerService } from "@/services";
import { Asset, type GasFloatStatus, type GasStationConfig, LedgerAccountKey } from "@/types";
import type { ReconcilerBreaker } from "../reconcile/external-reconciler.js";

export interface GasFunder {
  fund(input: {
    chain: string;
    address: string;
    minNativeBaseUnits: bigint;
    idempotencyKey: string;
  }): Promise<{ funded: bigint }>;
}

/**
 * Where the gas float's balance is read from.
 *
 * This is a port because the answer differs by deployment, and getting it wrong
 * fails in opposite directions: a source that reads low freezes payouts that
 * could have succeeded, and one that reads high lets a payout reach the chain
 * with no gas behind it.
 */
export interface GasFloatSource {
  available(chain: string, nativeAsset: string): Promise<bigint>;
}

/**
 * The float as the ledger records it (`gas_float:{chain}`, ADR 0010).
 *
 * Correct ONLY for a deployment that posts every gas movement to that account.
 * Nothing in this engine does yet — `payoutSettled`/`feeSwept` take an optional
 * `networkFee` leg and no caller supplies one — so the account reads 0 and this
 * source would report every chain as depleted. Use `TreasuryGasFloat` until
 * those postings exist; this is kept for the deployment that maintains them,
 * and for tests that seed the account directly.
 */
export class LedgerGasFloat implements GasFloatSource {
  constructor(private readonly ledger: LedgerService) {}

  available(chain: string, nativeAsset: string): Promise<bigint> {
    return this.ledger.getBalance(LedgerAccountKey(`gas_float:${chain}`), Asset(nativeAsset));
  }
}

/**
 * The float as the chain reports it: the native balance of the address that
 * actually pays for gas top-ups.
 *
 * This is the authoritative answer, because it is the same balance
 * `BroadcasterGasFunder` spends from. An unconfigured treasury reports 0, which
 * reads as depleted — correct, since there is nothing to fund from.
 */
export class TreasuryGasFloat implements GasFloatSource {
  constructor(
    private readonly balances: AddressBalance,
    private readonly treasuryOf: (chain: string) => { address: string } | undefined,
  ) {}

  async available(chain: string, nativeAsset: string): Promise<bigint> {
    const treasury = this.treasuryOf(chain);
    if (!treasury) return 0n;
    return this.balances.balance(chain, treasury.address, nativeAsset);
  }
}

export class GasStation {
  constructor(
    private readonly float: GasFloatSource,
    private readonly configs: ReadonlyMap<string, GasStationConfig>,
    private readonly funder?: GasFunder,
    private readonly breaker?: ReconcilerBreaker,
  ) {}

  private configFor(chain: string): GasStationConfig {
    const c = this.configs.get(chain);
    if (!c) throw new Error(`No gas-station config for chain ${chain}`);
    return c;
  }

  async floatStatus(chain: string): Promise<GasFloatStatus> {
    const c = this.configFor(chain);
    const balance = await this.float.available(chain, c.nativeAsset);
    return { chain, balance, floor: c.floorBaseUnits, healthy: balance >= c.floorBaseUnits };
  }

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

  async provision(input: {
    chain: string;
    address: string;
    minNativeBaseUnits: bigint;
    idempotencyKey: string;
  }): Promise<{ funded: bigint }> {
    // Checked before the float, because "no funder" is a configuration fault and
    // reporting it as a depleted float sends the operator to the wrong problem.
    if (!this.funder) {
      throw new GasTreasuryNotConfiguredError(
        [
          `Cannot provision gas on ${input.chain}: no gas treasury is configured.`,
          "Set CIXTECH_GAS_TREASURY_ADDRESS and CIXTECH_GAS_TREASURY_INDEX, or token",
          "payouts on this chain cannot pay their own fee.",
        ].join(" "),
        { context: { chain: input.chain } },
      );
    }
    const status = await this.floatStatus(input.chain);
    if (!status.healthy) {
      if (this.breaker) {
        await this.breaker.trip(`gas_float:${input.chain} below floor; refusing to provision gas`);
      }
      const native = this.configFor(input.chain).nativeAsset;
      throw new GasFloatDepletedError(
        [
          `Gas float for ${input.chain} is below its floor`,
          `(${status.balance} < ${status.floor} ${native} base units) —`,
          "top up the gas treasury before retrying this payout.",
        ].join(" "),
        {
          context: {
            chain: input.chain,
            nativeAsset: native,
            balance: status.balance.toString(),
            floor: status.floor.toString(),
          },
        },
      );
    }
    return this.funder.fund(input);
  }
}
