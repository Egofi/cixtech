import { buildRouter } from "@/chains/build-router.js";
import { ChainMisconfiguredError } from "@/common";
import type { SqlClient } from "@/types";

import { beforeEach, describe, expect, it } from "vitest";

const sql = { query: async () => ({ rows: [] }) } as unknown as SqlClient;

const XPRV =
  "xprv9s21ZrQH143K3QTDL4LXw2F7HEK3wJUD2nW2nRk4stbPy6cq3jPPqjiChkVvvNKmPGJxWUtg6LnF5kejMRNNU3TGtRBeJgk33yuGBxrMPHi";

const baseEnv = () =>
  ({ CHAIN_ENV: "testnet", CIXTECH_ENGINE_XPRV: XPRV }) as Record<string, string | undefined>;

describe("a chain that cannot resolve its tokens must not register", () => {
  beforeEach(() => {
    process.env["CHAIN_ENV"] = "testnet";
  });

  it("refuses to boot when an RPC URL is set but the token address is not", () => {
    const env = { ...baseEnv(), TRON_RPC_URL: "https://nile.example" };
    expect(() => buildRouter(env, sql)).toThrow(ChainMisconfiguredError);
    expect(() => buildRouter(env, sql)).toThrow(/TRON_USDT_ADDRESS/);
  });

  it("names every missing token, not just the first", () => {
    const env = { ...baseEnv(), BASE_RPC_URL: "https://base.example" };
    expect(() => buildRouter(env, sql)).toThrow(/BASE_USDC_ADDRESS/);
    expect(() => buildRouter(env, sql)).toThrow(/BASE_USDT_ADDRESS/);
  });

  it("registers the chain once its tokens resolve", () => {
    const env = {
      ...baseEnv(),
      BASE_RPC_URL: "https://base.example",
      BASE_USDC_ADDRESS: "0x1111111111111111111111111111111111111111",
      BASE_USDT_ADDRESS: "0x2222222222222222222222222222222222222222",
    };
    const { router, chains } = buildRouter(env, sql);
    expect(chains).toEqual(["BASE"]);
    expect(router.has("BASE")).toBe(true);
  });

  it("treats an empty RPC URL as not configured, not as a broken chain", () => {
    const env = {
      ...baseEnv(),
      POLYGON_RPC_URL: "",
      POLYGON_USDC_ADDRESS: "",
      POLYGON_USDT_ADDRESS: "",
      BASE_RPC_URL: "https://base.example",
      BASE_USDC_ADDRESS: "0x1111111111111111111111111111111111111111",
      BASE_USDT_ADDRESS: "0x2222222222222222222222222222222222222222",
    };
    const { chains, skipped } = buildRouter(env, sql);
    expect(chains).toEqual(["BASE"]);
    expect(skipped.find((s) => s.chain === "POLYGON")?.reason).toMatch(/POLYGON_RPC_URL/);
  });

  it("leaves a chain alone when it has no RPC URL at all", () => {
    const env = {
      ...baseEnv(),
      BASE_RPC_URL: "https://base.example",
      BASE_USDC_ADDRESS: "0x1111111111111111111111111111111111111111",
      BASE_USDT_ADDRESS: "0x2222222222222222222222222222222222222222",
    };

    expect(() => buildRouter(env, sql)).not.toThrow();
  });
});

describe("the boot report says which chains are live and why the rest are not", () => {
  it("reports every unregistered chain with its reason", () => {
    const env = {
      ...baseEnv(),
      OPTIMISM_RPC_URL: "https://op.example",
      OPTIMISM_USDC_ADDRESS: "0x1111111111111111111111111111111111111111",
      OPTIMISM_USDT_ADDRESS: "0x2222222222222222222222222222222222222222",
    };
    const { chains, skipped } = buildRouter(env, sql);

    expect(chains).toEqual(["OPTIMISM"]);
    const byChain = Object.fromEntries(skipped.map((s) => [s.chain, s.reason]));
    expect(byChain["TRON"]).toMatch(/TRON_RPC_URL/);
    expect(byChain["ETHEREUM"]).toMatch(/ETHEREUM_RPC_URL/);
    expect(byChain["OPTIMISM"]).toBeUndefined();
  });
});

describe("the newly added EVM chains", () => {
  for (const chain of ["ETHEREUM", "AVALANCHE", "OPTIMISM"]) {
    it(`registers ${chain} from configuration alone`, () => {
      const env = {
        ...baseEnv(),
        [`${chain}_RPC_URL`]: "https://rpc.example",
        [`${chain}_USDC_ADDRESS`]: "0x1111111111111111111111111111111111111111",
        [`${chain}_USDT_ADDRESS`]: "0x2222222222222222222222222222222222222222",
      };
      const { router, chains } = buildRouter(env, sql);
      expect(chains).toEqual([chain]);
      expect(router.familyOf(chain)).toBe("EVM");
    });
  }
});
