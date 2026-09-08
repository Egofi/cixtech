import type { ChainAdapter, ChainDeposit, FinalityRule } from "../chain-adapter.js";
import type { HttpClient } from "../http.js";
import { deriveTronAddress } from "./address.js";
import { parseNativeTransfers } from "./native.js";
import { parseTrc20Response } from "./trc20.js";

export interface TronAdapterConfig {
  /** TronGrid base URL, from chain-config (env-driven, never a literal — §16.5). */
  baseUrl: string;
  /** Solidified-block depth before a deposit is credited (~19 on Tron). */
  confirmations: number;
  /** Optional TronGrid API key header. */
  apiKey?: string;
}

/**
 * Tron chain adapter for the money-in path. Derives receive addresses, and pulls
 * + parses TRC20 transfers from TronGrid. Finality (solidified-block depth) and
 * attribution are applied by the ingestor; the adapter only observes and parses.
 */
export class TronAdapter implements ChainAdapter {
  readonly chain = "TRON";
  readonly family = "TRON" as const;

  constructor(
    private readonly http: HttpClient,
    private readonly config: TronAdapterConfig,
  ) {}

  deriveAddress(xpub: string, index: number): string {
    return deriveTronAddress(xpub, index);
  }

  parseDeposits(raw: unknown): ChainDeposit[] {
    return parseTrc20Response(raw);
  }

  finality(): FinalityRule {
    return { confirmations: this.config.confirmations };
  }

  private headers(): Record<string, string> {
    return this.config.apiKey ? { "TRON-PRO-API-KEY": this.config.apiKey } : {};
  }

  /** Live poll: fetch inbound TRC20 transfers to `address` and parse them. */
  async fetchInboundTrc20(address: string): Promise<ChainDeposit[]> {
    const url = `${this.config.baseUrl}/v1/accounts/${address}/transactions/trc20?only_to=true&limit=50`;
    return this.parseDeposits(await this.http.getJson(url, this.headers()));
  }

  /** Live poll: fetch inbound native TRX transfers to `address` (successful only). */
  async fetchInboundNative(address: string): Promise<ChainDeposit[]> {
    const url = `${this.config.baseUrl}/v1/accounts/${address}/transactions?only_to=true&limit=50`;
    const deposits = parseNativeTransfers(await this.http.getJson(url, this.headers()));
    return deposits.filter((d) => d.to === address); // credit only transfers addressed to us
  }

  /** The latest SOLIDIFIED block number — Tron's finality frontier (irreversible). */
  async solidifiedBlockNumber(): Promise<number> {
    const d = await this.http.postJson<{ block_header?: { raw_data?: { number?: number } } }>(
      `${this.config.baseUrl}/walletsolidity/getnowblock`,
      {},
      this.headers(),
    );
    return d.block_header?.raw_data?.number ?? 0;
  }

  /** The block a transaction landed in, or null if not yet mined. */
  async transactionBlock(txId: string): Promise<number | null> {
    const d = await this.http.postJson<{ blockNumber?: number }>(
      `${this.config.baseUrl}/wallet/gettransactioninfobyid`,
      { value: txId },
      this.headers(),
    );
    return typeof d.blockNumber === "number" ? d.blockNumber : null;
  }

  /**
   * Inbound TRC20 deposits that are FINAL — i.e. in a solidified (irreversible)
   * block. This is what detection must credit against, since a not-yet-solidified
   * deposit can still be reorged out. Use this as the DepositSource in production.
   */
  async confirmedInboundTrc20(address: string): Promise<ChainDeposit[]> {
    const deposits = await this.fetchInboundTrc20(address);
    if (deposits.length === 0) return [];
    const solidified = await this.solidifiedBlockNumber();
    const confirmed: ChainDeposit[] = [];
    for (const deposit of deposits) {
      const block = await this.transactionBlock(deposit.txId);
      if (block !== null && block > 0 && block <= solidified) {
        confirmed.push({ ...deposit, blockNumber: block });
      }
    }
    return confirmed;
  }
}
