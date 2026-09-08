/** Who owns a deposit address, and the fee that applies to deposits there. */
export interface AttributionEntry {
  tenant: string;
  merchant: string;
  feeBasisPoints: number;
}

/** Resolves an on-chain deposit address to its owning account (ADR 0009). */
export interface Attribution {
  resolve(chain: string, address: string): Promise<AttributionEntry | null>;
}
