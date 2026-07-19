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
}

export interface BroadcastResult {
  txId: string;
}

/**
 * Sends a payout on-chain. The real Tron implementation builds the transfer via
 * the node, signs the txID with the `Signer`, and broadcasts. Behind a port so
 * the payout ledger flow is testable without a network, and so a live broadcast
 * (which needs a funded, engine-controlled key) is a swap-in, not a rewrite.
 */
export interface PayoutBroadcaster {
  send(req: PayoutRequest): Promise<BroadcastResult>;
}
