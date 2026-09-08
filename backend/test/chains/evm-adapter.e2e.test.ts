import { TRANSFER_EVENT_TOPIC, erc20TransferData } from "@/chains/evm/abi.js";
import { evmAddressFromPubkey } from "@/chains/evm/address.js";
import { EvmAdapter, addressTopic } from "@/chains/evm/evm-adapter.js";
import { EvmBalanceProvider } from "@/chains/evm/evm-balance.js";
import { EvmPayoutBroadcaster } from "@/chains/evm/evm-broadcaster.js";
import { EvmRpc, toQuantity } from "@/chains/evm/evm-rpc.js";
import type { HttpClient } from "@/chains/http.js";
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { describe, expect, it } from "vitest";

const USDC = "0x1234567890abcdef1234567890abcdef12345678";
const POOL = "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359";

/** A programmable JSON-RPC endpoint: map method → handler over the request params. */
function rpcHttp(handlers: Record<string, (params: unknown[]) => unknown>): {
  http: HttpClient;
  sent: unknown[];
} {
  const sent: unknown[] = [];
  const http: HttpClient = {
    async getJson() {
      throw new Error("unused");
    },
    async postJson<T>(_url: string, body: unknown): Promise<T> {
      const { method, params, id } = body as { method: string; params: unknown[]; id: number };
      const handler = handlers[method];
      if (!handler) throw new Error(`unexpected RPC ${method}`);
      if (method === "eth_sendRawTransaction") sent.push(params[0]);
      return { jsonrpc: "2.0", id, result: handler(params) } as T;
    },
  };
  return { http, sent };
}

/** A Signer backed by a known secp256k1 key, so we can assert the sender. */
function keySigner(priv: Uint8Array) {
  return {
    deriveAddress: (_i: number) => evmAddressFromPubkey(secp256k1.getPublicKey(priv, true)),
    signHash(_index: number, hash: Uint8Array): Uint8Array {
      const sig = secp256k1.sign(hash, priv);
      const out = new Uint8Array(65);
      out.set(sig.toCompactRawBytes(), 0);
      out[64] = sig.recovery;
      return out;
    },
  };
}

describe("EVM balance provider", () => {
  it("reads native via eth_getBalance and ERC20 via balanceOf", async () => {
    const { http } = rpcHttp({
      eth_getBalance: () => toQuantity(7_000_000_000_000_000_000n),
      eth_call: () => toQuantity(250_000_000n),
    });
    const rpc = new EvmRpc(http, "http://rpc");
    const balances = new EvmBalanceProvider(rpc, { USDC }, "ETH");
    expect(await balances.balance("BASE", POOL, "ETH")).toBe(7_000_000_000_000_000_000n);
    expect(await balances.balance("BASE", POOL, "USDC")).toBe(250_000_000n);
    expect(await balances.balance("BASE", POOL, "DAI")).toBe(0n); // untracked → 0
  });
});

describe("EVM payout broadcaster", () => {
  it("signs an ERC20 transfer and broadcasts a type-2 tx the node accepts", async () => {
    const priv = secp256k1.utils.randomSecretKey();
    let broadcastRaw = "";
    const { http, sent } = rpcHttp({
      eth_getTransactionCount: () => toQuantity(5n),
      eth_maxPriorityFeePerGas: () => toQuantity(2_000_000_000n),
      eth_getBlockByNumber: () => ({ number: toQuantity(1000n), baseFeePerGas: toQuantity(30n) }),
      eth_sendRawTransaction: (p) => {
        broadcastRaw = p[0] as string;
        // Echo the correct hash so the broadcaster's local/remote check passes.
        return `0x${Buffer.from(keccak_256(Buffer.from(broadcastRaw.slice(2), "hex"))).toString("hex")}`;
      },
    });
    const rpc = new EvmRpc(http, "http://rpc");
    const bc = new EvmPayoutBroadcaster(rpc, keySigner(priv), {
      chainId: 8453n,
      tokenContracts: { USDC },
      nativeSymbol: "ETH",
    });
    const res = await bc.send({
      chain: "BASE",
      asset: "USDC",
      amountBaseUnits: 1_000_000n,
      fromAddress: evmAddressFromPubkey(secp256k1.getPublicKey(priv, true)),
      fromDerivationIndex: 0,
      toAddress: POOL,
    });
    expect(res.txId).toMatch(/^0x[0-9a-f]{64}$/);
    expect(sent).toHaveLength(1);
    // Raw tx is a type-2 envelope carrying the ERC20 transfer calldata to the token.
    expect(broadcastRaw.startsWith("0x02")).toBe(true);
    expect(broadcastRaw).toContain(
      Buffer.from(erc20TransferData(POOL, 1_000_000n)).toString("hex"),
    );
  });
});

describe("EVM deposit detection (ERC20, finality-gated)", () => {
  const transferLog = (amount: bigint, block: bigint) => ({
    address: USDC,
    topics: [
      TRANSFER_EVENT_TOPIC,
      addressTopic("0x000000000000000000000000000000000000dEaD"),
      addressTopic(POOL),
    ],
    data: toQuantity(amount),
    blockNumber: toQuantity(block),
    transactionHash: `0x${"ab".repeat(32)}`,
    logIndex: toQuantity(2n),
  });

  it("returns only deposits buried under the confirmation depth, mapped to a symbol", async () => {
    const { http } = rpcHttp({
      eth_blockNumber: () => toQuantity(1050n),
      // safe head = 1050 - 20 = 1030; the log at 1000 is final.
      eth_getLogs: () => [transferLog(1_000_000n, 1000n)],
    });
    const adapter = new EvmAdapter(new EvmRpc(http, "http://rpc"), {
      chain: "BASE",
      confirmations: 20,
      tokenContracts: { USDC },
    });
    const deposits = await adapter.confirmedInboundErc20(POOL, 990n);
    expect(deposits).toHaveLength(1);
    expect(deposits[0]).toMatchObject({
      chain: "BASE",
      asset: "USDC",
      to: POOL,
      amountBaseUnits: 1_000_000n,
      blockNumber: 1000,
    });
  });

  it("skips scanning when the safe head is behind the cursor", async () => {
    const { http } = rpcHttp({ eth_blockNumber: () => toQuantity(1005n) });
    const adapter = new EvmAdapter(new EvmRpc(http, "http://rpc"), {
      chain: "BASE",
      confirmations: 20,
      tokenContracts: { USDC },
    });
    // safe = 985 < cursor 990 → nothing final yet, no getLogs call.
    expect(await adapter.confirmedInboundErc20(POOL, 990n)).toEqual([]);
  });

  it("ignores Transfer logs for tokens we do not custody", async () => {
    const adapter = new EvmAdapter(new EvmRpc(rpcHttp({}).http, "http://rpc"), {
      chain: "BASE",
      confirmations: 20,
      tokenContracts: { USDC },
    });
    const foreign = {
      address: "0x9999999999999999999999999999999999999999",
      topics: [TRANSFER_EVENT_TOPIC, addressTopic(POOL), addressTopic(POOL)],
      data: toQuantity(1n),
      blockNumber: toQuantity(1n),
      transactionHash: `0x${"cd".repeat(32)}`,
      logIndex: toQuantity(0n),
    };
    expect(adapter.parseDeposits([foreign])).toEqual([]);
  });
});
