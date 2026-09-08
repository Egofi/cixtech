import type { HttpClient } from "../http.js";

export const toQuantity = (n: bigint): string => `0x${n.toString(16)}`;
export const fromQuantity = (hex: string | undefined): bigint =>
  hex && hex !== "0x" ? BigInt(hex) : 0n;

interface JsonRpcResponse<T> {
  result?: T;
  error?: { code: number; message: string };
}

export interface EvmLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  transactionHash: string;
  logIndex: string;
}

interface BlockHeader {
  number: string;
  baseFeePerGas?: string;
}

/**
 * A thin, typed Ethereum JSON-RPC client over the shared HttpClient — one code
 * path serves every EVM chain (Polygon, BSC, Arbitrum, Base); only the RPC URL and
 * chainId differ. Encoding/finality live in the adapter and broadcaster; this is
 * pure transport.
 */
export class EvmRpc {
  private id = 0;

  constructor(
    private readonly http: HttpClient,
    private readonly url: string,
    private readonly headers: Record<string, string> = {},
  ) {}

  private async call<T>(method: string, params: unknown[]): Promise<T> {
    const body = { jsonrpc: "2.0", id: ++this.id, method, params };
    const res = await this.http.postJson<JsonRpcResponse<T>>(this.url, body, this.headers);
    if (res.error) throw new Error(`${method} failed: ${res.error.code} ${res.error.message}`);
    return res.result as T;
  }

  async chainId(): Promise<bigint> {
    return fromQuantity(await this.call<string>("eth_chainId", []));
  }

  async nonce(address: string): Promise<bigint> {
    // "pending" so back-to-back payouts from one address don't collide on nonce.
    return fromQuantity(await this.call<string>("eth_getTransactionCount", [address, "pending"]));
  }

  async nativeBalance(address: string): Promise<bigint> {
    return fromQuantity(await this.call<string>("eth_getBalance", [address, "latest"]));
  }

  async ethCall(to: string, data: string): Promise<string> {
    return this.call<string>("eth_call", [{ to, data }, "latest"]);
  }

  async maxPriorityFeePerGas(): Promise<bigint> {
    return fromQuantity(await this.call<string>("eth_maxPriorityFeePerGas", []));
  }

  async block(tag: string): Promise<{ number: bigint; baseFeePerGas: bigint }> {
    const b = await this.call<BlockHeader>("eth_getBlockByNumber", [tag, false]);
    return { number: fromQuantity(b.number), baseFeePerGas: fromQuantity(b.baseFeePerGas) };
  }

  async blockNumber(): Promise<bigint> {
    return fromQuantity(await this.call<string>("eth_blockNumber", []));
  }

  async getLogs(params: {
    fromBlock: string;
    toBlock: string;
    address?: string;
    topics?: (string | string[] | null)[];
  }): Promise<EvmLog[]> {
    return this.call<EvmLog[]>("eth_getLogs", [params]);
  }

  async sendRawTransaction(raw: string): Promise<string> {
    return this.call<string>("eth_sendRawTransaction", [raw]);
  }
}
