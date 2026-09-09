import { InvalidAuthorizationError } from "@/common";
import type { BroadcastResult, PayoutRequest } from "@/types";
import { type AuthorizationSigner, transferCommitment } from "./authorization.js";
import type { PayoutBroadcaster } from "./broadcaster.js";

export class AuthorizingBroadcaster implements PayoutBroadcaster {
  constructor(
    private readonly inner: PayoutBroadcaster,
    private readonly authorizer: AuthorizationSigner,
    private readonly mode: "require" | "optional" = "require",
  ) {}

  async send(req: PayoutRequest): Promise<BroadcastResult> {
    if (!req.authorization) {
      if (this.mode === "require") {
        throw new InvalidAuthorizationError(
          "Refusing to broadcast a payout without authorization",
          { exposable: true },
        );
      }
      return this.inner.send(req);
    }
    const expectedSighash = transferCommitment({
      intentId: req.authorization.claims.intentId,
      chain: req.chain,
      asset: req.asset,
      amount: req.amountBaseUnits.toString(),
      destination: req.toAddress,
      fromAddress: req.fromAddress,
    });

    this.authorizer.verify(req.authorization, { expectedSighash });
    return this.inner.send(req);
  }
}
