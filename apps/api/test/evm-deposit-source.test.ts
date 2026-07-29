import { EvmAdapter, EvmRpc, type HttpClient, toQuantity } from "@cixtech/chains";
import type { SqlClient } from "@cixtech/ledger";
import { freshDatabase } from "@cixtech/testing";
import { beforeEach, describe, expect, it } from "vitest";
import { CURSOR_SCHEMA_SQL, DepositCursorStore } from "../src/chains/deposit-cursor.js";
import { EvmDepositSource } from "../src/chains/evm-deposit-source.js";

const USDC = "0x1234567890abcdef1234567890abcdef12345678";
const POOL = "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359";
const TRANSFER = `0x${"ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"}`;

/** A scriptable EVM RPC where the head block advances between polls. */
function scriptedRpc(state: { head: bigint; logsByFrom: Map<string, number> }): {
  http: HttpClient;
  getLogsCalls: { fromBlock: string; toBlock: string }[];
} {
  const getLogsCalls: { fromBlock: string; toBlock: string }[] = [];
  const http: HttpClient = {
    async getJson() {
      throw new Error("unused");
    },
    async postJson<T>(_url: string, body: unknown): Promise<T> {
      const { method, params, id } = body as { method: string; params: unknown[]; id: number };
      let result: unknown;
      if (method === "eth_blockNumber") result = toQuantity(state.head);
      else if (method === "eth_getLogs") {
        const p = params[0] as { fromBlock: string; toBlock: string };
        getLogsCalls.push({ fromBlock: p.fromBlock, toBlock: p.toBlock });
        // One deposit at block 1000 iff the scan window covers it.
        const from = BigInt(p.fromBlock);
        const to = BigInt(p.toBlock);
        result =
          from <= 1000n && 1000n <= to
            ? [
                {
                  address: USDC,
                  topics: [
                    TRANSFER,
                    `0x${"0".repeat(24)}${"11".repeat(20)}`,
                    `0x${"0".repeat(24)}${POOL.slice(2).toLowerCase()}`,
                  ],
                  data: toQuantity(5_000_000n),
                  blockNumber: toQuantity(1000n),
                  transactionHash: `0x${"ab".repeat(32)}`,
                  logIndex: toQuantity(0n),
                },
              ]
            : [];
      } else throw new Error(`unexpected ${method}`);
      return { jsonrpc: "2.0", id, result } as T;
    },
  };
  return { http, getLogsCalls };
}

describe("EvmDepositSource durable cursor", () => {
  let sql: SqlClient;
  beforeEach(async () => {
    const db = await freshDatabase();
    await db.exec(CURSOR_SCHEMA_SQL);
    sql = db.sql;
  });

  it("seeds the cursor behind the head, then advances and never rescans", async () => {
    const state = { head: 1100n, logsByFrom: new Map<string, number>() };
    const { http, getLogsCalls } = scriptedRpc(state);
    const rpc = new EvmRpc(http, "http://rpc");
    const adapter = new EvmAdapter(rpc, {
      chain: "BASE",
      confirmations: 20,
      tokenContracts: { USDC },
    });
    const cursors = new DepositCursorStore(sql);
    const source = new EvmDepositSource(adapter, rpc, cursors, { initialLookbackBlocks: 200 });

    // First poll: seed cursor = head(1100) - 200 = 900; safe = 1100 - 20 = 1080.
    // Window [900, 1080] covers the deposit at 1000 → credited.
    const first = await source.fetchInbound("BASE", POOL);
    expect(first).toHaveLength(1);
    expect(first[0]?.amountBaseUnits).toBe(5_000_000n);
    expect(getLogsCalls[0]).toEqual({ fromBlock: toQuantity(900n), toBlock: toQuantity(1080n) });
    expect(await cursors.get("BASE", POOL)).toBe(1081n); // advanced past the scanned window

    // Second poll, head unchanged: safe(1080) < cursor(1081) → nothing to scan.
    const second = await source.fetchInbound("BASE", POOL);
    expect(second).toHaveLength(0);
    expect(getLogsCalls).toHaveLength(1); // no new getLogs — cursor held

    // Head advances: scans only the NEW window [1081, 1100-20=... ] once final.
    state.head = 1140n; // safe = 1120
    await source.fetchInbound("BASE", POOL);
    expect(getLogsCalls[1]).toEqual({ fromBlock: toQuantity(1081n), toBlock: toQuantity(1120n) });
    expect(await cursors.get("BASE", POOL)).toBe(1121n);
  });
});
