import { GasTreasuryNotConfiguredError } from "@/common";
import type { GatherPreparation, GatherStrategyKind, PrepareGatherInput } from "@/types";
import type { GatherStrategy } from "./gather-strategy.js";
import type { AddressDeriver } from "./pool-manager.js";

export interface NativeGasProvisioner {
  provision(input: {
    chain: string;
    address: string;
    minNativeBaseUnits: bigint;
    idempotencyKey: string;
  }): Promise<{ funded: bigint }>;
}

export interface EoaGatherOptions {
  gasRequirementBaseUnits?: ReadonlyMap<string, bigint>;

  nativeAssetOf?: (chain: string) => string | undefined;
}

export class EoaFundTransferStrategy implements GatherStrategy {
  readonly kind: GatherStrategyKind = "EOA_FUND_TRANSFER";

  constructor(
    private readonly derive: AddressDeriver,
    private readonly gas?: NativeGasProvisioner,
    private readonly options: EoaGatherOptions = {},
  ) {}

  deriveAddress(chain: string, xpub: string, index: number): string {
    return this.derive(chain, xpub, index);
  }

  async prepare(input: PrepareGatherInput): Promise<GatherPreparation> {
    const required = this.options.gasRequirementBaseUnits?.get(input.chain);
    if (required === undefined || required <= 0n) return { fundedNativeBaseUnits: 0n };

    const native = this.options.nativeAssetOf?.(input.chain);
    if (native && native.toUpperCase() === input.asset.toUpperCase()) {
      return { fundedNativeBaseUnits: 0n };
    }

    if (!this.gas) {
      throw new GasTreasuryNotConfiguredError(
        `${input.chain} token payouts need native gas in the pool address, but no gas provisioner is configured`,
        { context: { chain: input.chain, asset: input.asset } },
      );
    }

    const { funded } = await this.gas.provision({
      chain: input.chain,
      address: input.address,
      minNativeBaseUnits: required,
      idempotencyKey: `gas:${input.idempotencyKey}`,
    });
    return { fundedNativeBaseUnits: funded };
  }
}
