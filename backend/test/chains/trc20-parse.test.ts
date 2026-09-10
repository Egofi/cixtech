import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseTrc20Response } from "@/chains/tron/trc20.js";
import { TronAdapter } from "@/chains/tron/tron-adapter.js";
import { describe, expect, it } from "vitest";

const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/trongrid-trc20.json", import.meta.url)), "utf8"),
);

const adapter = new TronAdapter(
  {
    async getJson() {
      throw new Error("unused");
    },
    async postJson() {
      throw new Error("unused");
    },
  },
  { baseUrl: "http://unused", confirmations: 19 },
);

describe("TRC20 deposit parsing", () => {
  it("extracts only Transfer rows and maps them to ChainDeposits", () => {
    const deposits = parseTrc20Response(fixture);
    expect(deposits).toHaveLength(1);
    expect(deposits[0]).toMatchObject({
      chain: "TRON",
      to: "TRecipient000000000000000000000000",
      asset: "USDT",
      amountBaseUnits: 1_000_000n,
      index: 0,
    });
  });

  it("keeps amount as an exact bigint (no float)", () => {
    const [d] = parseTrc20Response(fixture);
    expect(typeof d?.amountBaseUnits).toBe("bigint");
  });

  it("rejects a malformed response at the boundary rather than coercing it", () => {
    expect(() => parseTrc20Response({ data: [{ transaction_id: "x" }] })).toThrow();
    expect(() => parseTrc20Response({ nope: true })).toThrow();

    expect(() =>
      parseTrc20Response({
        data: [{ ...fixtureRow(), value: "1.5" }],
      }),
    ).toThrow();
  });

  it("exposes Tron finality depth", () => {
    expect(adapter.finality()).toEqual({ confirmations: 19 });
  });
});

function fixtureRow() {
  return {
    transaction_id: "t",
    from: "A",
    to: "B",
    type: "Transfer",
    value: "1",
    token_info: { symbol: "USDT", address: "C", decimals: 6 },
  };
}
