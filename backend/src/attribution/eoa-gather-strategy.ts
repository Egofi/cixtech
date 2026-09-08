import type {
  GatherPreparation,
  GatherStrategy,
  GatherStrategyKind,
  PrepareGatherInput,
} from "./gather-strategy.js";
import type { AddressDeriver } from "./pool-manager.js";

/**
 * Tops a pool address up with native gas so it can send a token transfer.
 * Implemented by the gas station (build spec §6.2); absent on chains that need no
 * pre-funding.
 */
export interface NativeGasProvisioner {
  provision(input: {
    chain: string;
    address: string;
    minNativeBaseUnits: bigint;
    idempotencyKey: string;
  }): Promise<{ funded: bigint }>;
}

export interface EoaGatherOptions {
  /**
   * Chains whose token transfers need native gas IN the sending address, mapped to
   * the amount to guarantee before a transfer. EVM ERC-20 and Tron TRC-20 both do;
   * UTXO does not (the fee comes out of the inputs).
   */
  gasRequirementBaseUnits?: ReadonlyMap<string, bigint>;
  /** Native asset symbol per chain, used to decide when a payout IS the gas token. */
  nativeAssetOf?: (chain: string) => string | undefined;
}

/**
 * Fund-then-transfer on plain HD EOAs (ADR 0011) — the bootstrap strategy.
 *
 * The address is the ordinary HD address for its index, so `deriveAddress` is the
 * chain plugin's own deriver and a payout signs directly with the pool key.
 *
 * `prepare` is the part that was missing and made EVM payouts impossible: an
 * ERC-20 `transfer` is executed BY the token holder, so the pool address must hold
 * native gas of its own. Pool addresses only ever receive USDC/USDT, so without a
 * top-up first, every EVM token payout fails for insufficient gas. Tron is the
 * same shape (energy/bandwidth, or burned TRX).
 *
 * Simple, and it leaves gas dust behind in each address — which is exactly why ADR
 * 0011 keeps CREATE2 forwarders as the volume answer behind the same port.
 */
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

    // Paying out the native asset itself needs no separate gas provisioning — the
    // gather amount and the fee come from the same balance, and topping up here
    // would race with the transfer that is about to spend it.
    const native = this.options.nativeAssetOf?.(input.chain);
    if (native && native.toUpperCase() === input.asset.toUpperCase()) {
      return { fundedNativeBaseUnits: 0n };
    }

    if (!this.gas) {
      throw new Error(
        `${input.chain} token payouts need native gas in the pool address, but no gas provisioner is configured`,
      );
    }
    // Keyed on the leg, so a retried payout tops up once rather than per attempt.
    const { funded } = await this.gas.provision({
      chain: input.chain,
      address: input.address,
      minNativeBaseUnits: required,
      idempotencyKey: `gas:${input.idempotencyKey}`,
    });
    return { fundedNativeBaseUnits: funded };
  }
}
