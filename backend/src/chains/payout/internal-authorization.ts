import type { AuthorizationToken } from "@/types";
import { type AuthorizationSigner, transferCommitment } from "./authorization.js";

const INTERNAL_AUTH_TTL_MS = 5 * 60_000;

export function mintInternalAuthorization(
  authorizer: AuthorizationSigner,
  t: {
    intentId: string;
    chain: string;
    asset: string;
    amountBaseUnits: bigint;
    fromAddress: string;
    toAddress: string;

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
