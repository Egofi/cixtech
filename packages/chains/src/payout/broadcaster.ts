import type { AuthorizationToken } from "./authorization.js";

/** An on-chain payout to build, sign, and broadcast. */
export interface PayoutRequest {
  chain: string;
  asset: string;
  amountBaseUnits: bigint;
  /** The pool/treasury address holding the funds (chosen by gathering). */
  fromAddress: string;
  /** The Signer derivation index whose key controls `fromAddress`. */
  fromDerivationIndex: number;
  toAddress: string;
  /**
   * Per-broadcast dedupe key. Implementations MUST be idempotent on it: a second
   * `send` with the same key must NOT produce a second on-chain transfer — it
   * returns the original tx id. This is what makes a crash between "sent" and
   * "recorded" safe against double-spend (build spec §16 / PayoutJournal).
   */
  idempotencyKey?: string;
  /**
   * The policy authorization binding this exact transfer (§7). When present the
   * signing boundary re-verifies its sighash before signing, so a substituted
   * transaction is refused.
   */
  authorization?: AuthorizationToken;
}

export interface BroadcastResult {
  txId: string;
}

/**
 * Sends a payout on-chain. The real Tron implementation builds the transfer via
 * the node, signs the txID with the `Signer`, and broadcasts. Behind a port so
 * the payout ledger flow is testable without a network, and so a live broadcast
 * (which needs a funded, engine-controlled key) is a swap-in, not a rewrite.
 *
 * Idempotency contract: `send` MUST be idempotent on `req.idempotencyKey`.
 */
export interface PayoutBroadcaster {
  send(req: PayoutRequest): Promise<BroadcastResult>;
}
