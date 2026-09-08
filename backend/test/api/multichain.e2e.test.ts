import type { AddressBalance } from "@/attribution";
import {
  type BroadcastResult,
  type ChainPlugin,
  type PayoutBroadcaster,
  type PayoutRequest,
  PolicyEngine,
  deriveEvmAddress,
} from "@/chains";
import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { auth, makeApi } from "./harness.js";

const EVM_DEST = "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359";

const plentiful: AddressBalance = {
  async balance() {
    return 10n ** 30n;
  },
};

/** A fake BASE (EVM) plugin with a recording broadcaster so we can assert routing. */
function baseChain(): ChainPlugin & { sent: PayoutRequest[] } {
  const sent: PayoutRequest[] = [];
  const broadcaster: PayoutBroadcaster = {
    async send(req): Promise<BroadcastResult> {
      sent.push(req);
      return { txId: `0x${"b".repeat(64)}` };
    },
  };
  return {
    chain: "BASE",
    family: "EVM",
    confirmations: 20,
    broadcaster,
    balances: plentiful,
    depositSource: {
      async fetchInbound() {
        return [];
      },
    },
    deriveAddress: (xpub, index) => deriveEvmAddress(xpub, index),
    sent,
  };
}

async function createAccount(app: FastifyInstance, apiKey: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/v1/accounts",
    headers: auth(apiKey),
    payload: {},
  });
  return res.json().id as string;
}

describe("multi-chain engine (ADR 0016)", () => {
  it("lists routable chains", async () => {
    const ctx = await makeApi({ extraChains: [baseChain()] });
    const res = await ctx.app.inject({
      method: "GET",
      url: "/v1/chains",
      headers: auth(ctx.apiKey),
    });
    expect(res.json().chains).toEqual(["TRON", "BASE"]);
  });

  it("derives a chain-appropriate deposit address (Tron base58 vs EVM 0x)", async () => {
    const ctx = await makeApi({ extraChains: [baseChain()] });
    const accountId = await createAccount(ctx.app, ctx.apiKey);

    const tron = await ctx.app.inject({
      method: "POST",
      url: `/v1/accounts/${accountId}/deposit-addresses`,
      headers: auth(ctx.apiKey),
      payload: { chain: "TRON", asset: "USDT" },
    });
    expect(tron.json().address.startsWith("T")).toBe(true);

    const base = await ctx.app.inject({
      method: "POST",
      url: `/v1/accounts/${accountId}/deposit-addresses`,
      headers: auth(ctx.apiKey),
      payload: { chain: "base", asset: "USDC" }, // lower-case → canonicalized
    });
    expect(base.statusCode).toBe(201);
    expect(base.json().address).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it("rejects an unroutable chain with 400 and consumes no pool index", async () => {
    const ctx = await makeApi({ extraChains: [baseChain()] });
    const accountId = await createAccount(ctx.app, ctx.apiKey);
    const res = await ctx.app.inject({
      method: "POST",
      url: `/v1/accounts/${accountId}/deposit-addresses`,
      headers: auth(ctx.apiKey),
      payload: { chain: "SOLANA", asset: "USDC" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("UNSUPPORTED_CHAIN");
  });

  it("routes a withdrawal to the addressed chain's broadcaster, not another chain's", async () => {
    const base = baseChain();
    const ctx = await makeApi({
      extraChains: [base],
      policy: new PolicyEngine({
        maxPerPayoutBaseUnits: 1_000_000_000n,
        allowlist: new Set([EVM_DEST]),
      }),
    });
    const accountId = await createAccount(ctx.app, ctx.apiKey);

    // Assign a BASE deposit address and credit a USDC deposit to it.
    const addr = await ctx.app.inject({
      method: "POST",
      url: `/v1/accounts/${accountId}/deposit-addresses`,
      headers: auth(ctx.apiKey),
      payload: { chain: "BASE", asset: "USDC" },
    });
    const address = addr.json().address as string;
    await ctx.engine.ingestor.ingestConfirmed({
      chain: "BASE",
      txId: "0xdeadbeef",
      index: 0,
      to: address,
      from: "0xsender",
      asset: "USDC",
      amountBaseUnits: 10_000_000n,
    });

    const pay = await ctx.app.inject({
      method: "POST",
      url: `/v1/accounts/${accountId}/withdrawals`,
      headers: { ...auth(ctx.apiKey), "idempotency-key": "b1" },
      payload: { chain: "BASE", asset: "USDC", amount: "1000000", destination: EVM_DEST },
    });
    expect(pay.statusCode).toBe(200);
    expect(pay.json().from).toBe(address);

    // The BASE broadcaster handled it; the default TRON one never saw it.
    expect(base.sent).toHaveLength(1);
    expect(base.sent[0]?.chain).toBe("BASE");
    expect(ctx.broadcaster.sent).toHaveLength(0);
  });
});
