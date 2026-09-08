import { type AuthorizationSigner, transferCommitment } from "./authorization.js";
import type { AuthorizationToken } from "./authorization.js";

/** Default lifetime of an internal transfer's authorization token. */
const INTERNAL_AUTH_TTL_MS = 5 * 60_000;

/**
 * Mint the authorization token for a transfer the ENGINE originates — a gas
 * top-up or a fee sweep — rather than one a tenant requested.
 *
 * These are still transfers out of custody addresses, so they must clear the same
 * signing-boundary check a payout does: without a token the `AuthorizingBroadcaster`
 * refuses them, and with one the sighash binds amount, destination and
 * from-address exactly as it does for a tenant payout. Before this existed both
 * paths reached past the wrapper and used the raw broadcaster, which is what let
 * the control plane move funds under weaker guarantees than the tenant API.
 *
 * `tenant` is the engine itself: these transfers belong to no tenant, and saying
 * so explicitly is better than borrowing a tenant id that did not authorize them.
 */
export function mintInternalAuthorization(
  authorizer: AuthorizationSigner,
  t: {
    intentId: string;
    chain: string;
    asset: string;
    amountBaseUnits: bigint;
    fromAddress: string;
    toAddress: string;
    /** What this transfer is for — recorded in the token's merchant slot for audit. */
    purpose: string;
  },
  ttlMs: number = INTERNAL_AUTH_TTL_MS,
): AuthorizationToken {
  const amount = t.amountBaseUnits.toString();
  return authorizer.mint(
    {
      intentId: t.intentId,
      tenant: "engine",
      merchant: t.purpose,
      chain: t.chain,
      asset: t.asset,
      amount,
      destination: t.toAddress,
      sighash: transferCommitment({
        intentId: t.intentId,
        chain: t.chain,
        asset: t.asset,
        amount,
        destination: t.toAddress,
        fromAddress: t.fromAddress,
      }),
      approvals: [],
    },
    { ttlMs },
  );
}
