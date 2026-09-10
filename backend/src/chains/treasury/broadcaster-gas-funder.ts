import type { AddressBalance } from "@/attribution";
import type { AuthorizationSigner } from "../payout/authorization.js";
import type { PayoutBroadcaster } from "../payout/broadcaster.js";
import { mintInternalAuthorization } from "../payout/internal-authorization.js";
import type { GasFunder } from "./gas-station.js";

export interface BroadcasterGasFunderConfig {
  nativeAssetOf: (chain: string) => string;

  treasuryOf: (chain: string) => { address: string; derivationIndex: number } | undefined;

  topUpMultiple?: bigint;

  authorizer?: AuthorizationSigner;
}

export class BroadcasterGasFunder implements GasFunder {
  constructor(
    private readonly broadcaster: PayoutBroadcaster,
    private readonly balances: AddressBalance,
    private readonly config: BroadcasterGasFunderConfig,
  ) {}

  async fund(input: {
    chain: string;
    address: string;
    minNativeBaseUnits: bigint;
    idempotencyKey: string;
  }): Promise<{ funded: bigint }> {
    const native = this.config.nativeAssetOf(input.chain);
    const held = await this.balances.balance(input.chain, input.address, native);
    if (held >= input.minNativeBaseUnits) return { funded: 0n };

    const treasury = this.config.treasuryOf(input.chain);
    if (!treasury) {
      throw new Error(
        `No gas treasury configured for ${input.chain}; cannot fund ${input.address} to send a token transfer`,
      );
    }

    const target = input.minNativeBaseUnits * (this.config.topUpMultiple ?? 1n);
    const amount = target - held;
    const authorization = this.config.authorizer
      ? mintInternalAuthorization(this.config.authorizer, {
          intentId: input.idempotencyKey,
          chain: input.chain,
          asset: native,
          amountBaseUnits: amount,
          fromAddress: treasury.address,
          toAddress: input.address,
          purpose: "gas-top-up",
        })
      : undefined;
    await this.broadcaster.send({
      chain: input.chain,
      asset: native,
      amountBaseUnits: amount,
      fromAddress: treasury.address,
      fromDerivationIndex: treasury.derivationIndex,
      toAddress: input.address,
      idempotencyKey: input.idempotencyKey,
      ...(authorization ? { authorization } : {}),
    });
    return { funded: amount };
  }
}
