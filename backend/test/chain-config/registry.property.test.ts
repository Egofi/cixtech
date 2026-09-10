import { ChainRegistry } from "@/chain-config/registry.js";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

describe("chain-config registry (§16.5)", () => {
  it("[13] token lookup is total for supported (chain, symbol) and throws otherwise", () => {
    const reg = new ChainRegistry("mainnet");

    for (const chain of reg.chains()) {
      expect(() => reg.chain(chain)).not.toThrow();
    }

    expect(reg.token("TRON", "USDT").decimals).toBe(6);

    fc.assert(
      fc.property(fc.string(), fc.string(), (chain, symbol) => {
        const supported =
          reg.chains().includes(chain.toUpperCase()) &&
          ["USDT", "TRX"].includes(symbol.toUpperCase());
        if (!supported) {
          expect(() => reg.token(chain, symbol)).toThrow();
        }
      }),
    );
  });

  it.todo("[14] no chain id / address / rpc literal outside chain-config (CI guard)");
});
