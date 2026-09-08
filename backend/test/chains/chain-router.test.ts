import type { AddressBalance } from "@/attribution";
import type { ChainDeposit, DepositSource } from "@/chains/chain-adapter.js";
import { type ChainPlugin, ChainRouter, UnsupportedChainError } from "@/chains/chain-router.js";
import type {
  BroadcastResult,
  PayoutBroadcaster,
  PayoutRequest,
} from "@/chains/payout/broadcaster.js";
import { describe, expect, it } from "vitest";

function plugin(chain: string): ChainPlugin & { sent: PayoutRequest[] } {
  const sent: PayoutRequest[] = [];
  const broadcaster: PayoutBroadcaster = {
    async send(req): Promise<BroadcastResult> {
      sent.push(req);
      return { txId: `${chain}-tx` };
    },
  };
  const balances: AddressBalance = {
    async balance(_c, _a, _asset) {
      return chain === "TRON" ? 1n : 2n;
    },
  };
  const depositSource: DepositSource = {
    async fetchInbound(c, address): Promise<ChainDeposit[]> {
      return [
        {
          chain: c,
          txId: `${chain}-dep`,
          index: 0,
          to: address,
          from: "x",
          asset: "USDC",
          amountBaseUnits: 1n,
        },
      ];
    },
  };
  return {
    chain,
    family: chain === "TRON" ? "TRON" : "EVM",
    confirmations: 10,
    broadcaster,
    balances,
    depositSource,
    deriveAddress: (_xpub, index) => `${chain}-addr-${index}`,
    sent,
  };
}

describe("ChainRouter", () => {
  const tron = plugin("TRON");
  const base = plugin("BASE");
  const router = new ChainRouter([tron, base]);

  it("lists routable chains and reports membership case-insensitively", () => {
    expect(router.chains()).toEqual(["TRON", "BASE"]);
    expect(router.has("base")).toBe(true);
    expect(router.has("SOLANA")).toBe(false);
  });

  it("routes each port to the addressed chain's plugin", async () => {
    await router.broadcaster.send({
      chain: "BASE",
      asset: "USDC",
      amountBaseUnits: 5n,
      fromAddress: "a",
      fromDerivationIndex: 0,
      toAddress: "b",
    });
    expect(base.sent).toHaveLength(1);
    expect(tron.sent).toHaveLength(0);

    expect(await router.balances.balance("TRON", "a", "USDC")).toBe(1n);
    expect(await router.balances.balance("BASE", "a", "USDC")).toBe(2n);
    expect(router.deriveAddress("BASE", "xpub", 7)).toBe("BASE-addr-7");
    expect((await router.depositSource.fetchInbound("TRON", "addr"))[0]?.txId).toBe("TRON-dep");
  });

  it("throws UnsupportedChainError for an unregistered chain", () => {
    expect(() => router.get("SOLANA")).toThrow(UnsupportedChainError);
    expect(router.deriveAddress.bind(null, "SOLANA", "x", 0)).toThrow(UnsupportedChainError);
  });
});
