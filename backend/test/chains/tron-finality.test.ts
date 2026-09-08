import type { HttpClient } from "@/chains/http.js";
import { TronAdapter } from "@/chains/tron/tron-adapter.js";
import { describe, expect, it } from "vitest";

const ADDRESS = "TJkyXySVnHjqo6VDoRNxUoCh524ViKuv5h";

/** One raw TRC20 transfer row as TronGrid's /v1 endpoint returns it. */
function trc20Row(txId: string, value: string) {
  return {
    transaction_id: txId,
    token_info: { symbol: "USDT", decimals: 6, address: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t" },
    from: "TSender0000000000000000000000000000",
    to: ADDRESS,
    type: "Transfer",
    value,
  };
}

/**
 * Fake HTTP that answers the three endpoints finality needs, by URL:
 *  - GET  /v1/.../transactions/trc20  → the raw deposit list
 *  - POST /walletsolidity/getnowblock → the solidified block number
 *  - POST /wallet/gettransactioninfobyid → the block a given tx landed in
 */
function fakeHttp(solidified: number, txBlocks: Record<string, number>): HttpClient {
  return {
    async getJson<T>(url: string): Promise<T> {
      if (url.includes("/transactions/trc20")) {
        return { data: [trc20Row("txFinal", "1000000"), trc20Row("txPending", "2000000")] } as T;
      }
      throw new Error(`unexpected GET ${url}`);
    },
    async postJson<T>(url: string, body: unknown): Promise<T> {
      if (url.endsWith("/walletsolidity/getnowblock")) {
        return { block_header: { raw_data: { number: solidified } } } as T;
      }
      if (url.endsWith("/wallet/gettransactioninfobyid")) {
        const txId = (body as { value: string }).value;
        const block = txBlocks[txId];
        return (block === undefined ? {} : { blockNumber: block }) as T;
      }
      throw new Error(`unexpected POST ${url}`);
    },
  };
}

describe("Tron finality (solidified-block confirmation)", () => {
  const config = { baseUrl: "https://nile.trongrid.io", confirmations: 19 };

  it("credits only deposits in a solidified block; drops not-yet-final ones", async () => {
    // Solidified frontier at 100; txFinal is at 90 (final), txPending at 110 (not yet).
    const adapter = new TronAdapter(fakeHttp(100, { txFinal: 90, txPending: 110 }), config);
    const confirmed = await adapter.confirmedInboundTrc20(ADDRESS);
    expect(confirmed.map((d) => d.txId)).toEqual(["txFinal"]);
    expect(confirmed[0]?.blockNumber).toBe(90);
  });

  it("drops a deposit whose tx is not yet mined (no blockNumber)", async () => {
    const adapter = new TronAdapter(fakeHttp(100, { txFinal: 90 }), config); // txPending unmined
    const confirmed = await adapter.confirmedInboundTrc20(ADDRESS);
    expect(confirmed.map((d) => d.txId)).toEqual(["txFinal"]);
  });

  it("exposes the solidified frontier and a tx's block directly", async () => {
    const adapter = new TronAdapter(fakeHttp(250, { txFinal: 200 }), config);
    expect(await adapter.solidifiedBlockNumber()).toBe(250);
    expect(await adapter.transactionBlock("txFinal")).toBe(200);
    expect(await adapter.transactionBlock("unknown")).toBeNull();
  });
});
