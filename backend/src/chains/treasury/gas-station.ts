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

  async floatStatus(chain: string): Promise<GasFloatStatus> {
    const c = this.configFor(chain);
    const balance = await this.ledger.getBalance(
      LedgerAccountKey(`gas_float:${chain}`),
      Asset(c.nativeAsset),
    );
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
