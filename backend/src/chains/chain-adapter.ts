import type { ChainDeposit, ChainFamily, FinalityRule } from "@/types";
export interface DepositSource {
  fetchInbound(chain: string, address: string): Promise<ChainDeposit[]>;

  reorged?(chain: string, address: string): Promise<ChainDeposit[]>;
}

export interface ChainAdapter {
  readonly chain: string;
  readonly family: ChainFamily;
  deriveAddress(xpub: string, index: number): string;
  parseDeposits(raw: unknown): ChainDeposit[];
  finality(): FinalityRule;
}

export interface Signer {
  deriveAddress(domainXpub: string, index: number): string;
}
