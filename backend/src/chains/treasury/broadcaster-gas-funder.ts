import type { AddressBalance } from "@/attribution";
import type { AuthorizationSigner } from "../payout/authorization.js";
import type { PayoutBroadcaster } from "../payout/broadcaster.js";
import { mintInternalAuthorization } from "../payout/internal-authorization.js";
import type { GasFunder } from "./gas-station.js";

export interface BroadcasterGasFunderConfig {
  /** Native gas asset symbol per chain (POL / BNB / ETH / TRX). */
  nativeAssetOf: (chain: string) => string;
  /**
   * The treasury address that pays for gas, and the Signer index controlling it.
   * Kept separate from the pool key domain: this spends engine funds, not
   * customer funds.
   */
  treasuryOf: (chain: string) => { address: string; derivationIndex: number } | undefined;
  /**
   * Top up to this multiple of the requested minimum, so a pool address is not
   * re-funded on every single payout. Default 1 (exact).
   */
  topUpMultiple?: bigint;
  /**
   * Mints the authorization token for the funding transfer (§7). Required whenever
   * the broadcaster is the authorizing one — which is every deployment with a
   * policy key — because a transfer with no token is refused at the signing
   * boundary. Absent only where no policy key is configured.
   */
  authorizer?: AuthorizationSigner;
}

/**
 * Funds a pool address with native gas by sending it a plain native transfer from
 * the treasury (build spec §6.2, "fund-then-transfer").
 *
 * Idempotency is the delicate part. The broadcaster dedupes on `idempotencyKey`,
 * so a retried payout leg reuses the original funding transfer rather than sending
 * a second one. The balance check in front of it is an optimisation, not the
 * safety property — two concurrent attempts could both observe a low balance, and
 * it is the shared key that stops them both spending.
 */
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
