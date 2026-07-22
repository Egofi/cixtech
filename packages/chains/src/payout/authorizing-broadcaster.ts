import {
  type AuthorizationSigner,
  InvalidAuthorizationError,
  transferCommitment,
} from "./authorization.js";
import type { BroadcastResult, PayoutBroadcaster, PayoutRequest } from "./broadcaster.js";

/**
 * The signing-boundary gate (ADR 0007's "last mile verifies what it can evaluate
 * independently"). Wraps any `PayoutBroadcaster` and, before delegating, re-verifies
 * the authorization token INDEPENDENTLY: the HMAC under the policy key, the expiry,
 * and — the load-bearing check — that the token's sighash commitment matches the
 * transfer actually about to be sent (amount, destination, from). A compromised
 * coordinator that swaps the destination or amount produces a mismatch and is
 * refused here, before any signing. A request with no authorization is rejected in
 * `require` mode.
 */
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
    // Throws InvalidAuthorizationError on a bad/expired/mismatched token.
    this.authorizer.verify(req.authorization, { expectedSighash });
    return this.inner.send(req);
  }
}
