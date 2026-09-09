import type { ChainDeposit, FinalityRule, TronAdapterConfig } from "@/types";
import type { ChainAdapter } from "../chain-adapter.js";
import type { HttpClient } from "../http.js";
import { deriveTronAddress } from "./address.js";
import { parseNativeTransfers } from "./native.js";
import { parseTrc20Response } from "./trc20.js";

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

  async fetchInboundTrc20(address: string): Promise<ChainDeposit[]> {
    const url = `${this.config.baseUrl}/v1/accounts/${address}/transactions/trc20?only_to=true&limit=50`;
    return this.parseDeposits(await this.http.getJson(url, this.headers()));
  }

  async fetchInboundNative(address: string): Promise<ChainDeposit[]> {
    const url = `${this.config.baseUrl}/v1/accounts/${address}/transactions?only_to=true&limit=50`;
    const deposits = parseNativeTransfers(await this.http.getJson(url, this.headers()));
    return deposits.filter((d) => d.to === address);
  }

  async solidifiedBlockNumber(): Promise<number> {
    const d = await this.http.postJson<{ block_header?: { raw_data?: { number?: number } } }>(
      `${this.config.baseUrl}/walletsolidity/getnowblock`,
      {},
      this.headers(),
    );
    return d.block_header?.raw_data?.number ?? 0;
  }

  async transactionBlock(txId: string): Promise<number | null> {
    const d = await this.http.postJson<{ blockNumber?: number }>(
      `${this.config.baseUrl}/wallet/gettransactioninfobyid`,
      { value: txId },
      this.headers(),
    );
    return typeof d.blockNumber === "number" ? d.blockNumber : null;
  }

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
