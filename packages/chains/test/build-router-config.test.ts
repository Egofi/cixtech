import type { SqlClient } from "@cixtech/ledger";
import { beforeEach, describe, expect, it } from "vitest";
import { ChainMisconfiguredError, buildRouter } from "../src/build-router.js";

/** buildRouter only needs a client to construct the cursor store; nothing queries here. */
const sql = { query: async () => ({ rows: [] }) } as unknown as SqlClient;

/** An account-level xprv is required to boot; this one is test-only. */
const XPRV =
  "xprv9s21ZrQH143K3QTDL4LXw2F7HEK3wJUD2nW2nRk4stbPy6cq3jPPqjiChkVvvNKmPGJxWUtg6LnF5kejMRNNU3TGtRBeJgk33yuGBxrMPHi";

const baseEnv = () =>
  ({ CHAIN_ENV: "testnet", CIXTECH_ENGINE_XPRV: XPRV }) as Record<string, string | undefined>;

describe("a chain that cannot resolve its tokens must not register", () => {
  beforeEach(() => {
    process.env["CHAIN_ENV"] = "testnet";
  });

  /**
   * The failure this prevents is silent, which is what makes it dangerous: an
   * unresolved contract makes the balance provider answer 0, the gatherer reads
   * 0 as "no funds on chain", and a payout is refused while the money sits in
   * the pool address. Nothing logs an error — the operator just sees a balance
   * that is wrong in the safe-looking direction.
   */
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

  it("leaves a chain alone when it has no RPC URL at all", () => {
    const env = {
      ...baseEnv(),
      BASE_RPC_URL: "https://base.example",
      BASE_USDC_ADDRESS: "0x1111111111111111111111111111111111111111",
      BASE_USDT_ADDRESS: "0x2222222222222222222222222222222222222222",
    };
    // TRON has no RPC URL, so its missing token address is not a misconfiguration.
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
