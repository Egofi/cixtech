export type ChainFamily = "EVM" | "UTXO" | "TRON" | "XRP";

export interface FinalityRule {
  /** Confirmations (or solidified-block depth) before a deposit may be credited (§9). */
  confirmations: number;
}

/** A parsed inbound transfer, before finality and attribution are applied. */
export interface ChainDeposit {
  chain: string;
  txId: string;
  /** Output/log index within the tx; 0 for a single-transfer. Part of the idempotency key. */
  index: number;
  to: string;
  from: string;
  /** Base token symbol, e.g. "USDT". */
  asset: string;
  /** TRC20/ERC20 contract; undefined for a native transfer. */
  tokenContract?: string;
  amountBaseUnits: bigint;
  blockNumber?: number;
}

/**
 * Fetches CONFIRMED inbound deposits for a watched address (past finality). The
 * source owns the finality rule for its chain (Tron: solidified block; EVM:
 * confirmation depth), so the detection loop can trust whatever it returns.
 */
export interface DepositSource {
  fetchInbound(chain: string, address: string): Promise<ChainDeposit[]>;
}

/**
 * One chain family behind one interface (spec §4). The core never knows which
 * chain it's on. `parseDeposits` must be idempotent on `(txId, index)`.
 */
export interface ChainAdapter {
  readonly chain: string;
  readonly family: ChainFamily;
  deriveAddress(xpub: string, index: number): string;
  parseDeposits(raw: unknown): ChainDeposit[];
  finality(): FinalityRule;
}

/**
 * Signing port (ADR 0007). Receive-address derivation is here so the key domain
 * owns it; transaction signing (`sign`) lands with the money-out / withdrawal
 * step. Backed initially by a keypair signer, later by in-house threshold MPC —
 * swapped without touching callers.
 */
export interface Signer {
  deriveAddress(domainXpub: string, index: number): string;
}
