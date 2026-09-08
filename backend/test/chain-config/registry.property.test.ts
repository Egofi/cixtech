import { ChainRegistry } from "@/chain-config/registry.js";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

describe("chain-config registry (§16.5)", () => {
  // Property 13 — lookups are total for supported inputs, and throw (never default) otherwise.
  it("[13] token lookup is total for supported (chain, symbol) and throws otherwise", () => {
    const reg = new ChainRegistry("mainnet");

    // Total for what it declares supported.
    for (const chain of reg.chains()) {
      expect(() => reg.chain(chain)).not.toThrow();
    }
    // Known-good pair resolves.
    expect(reg.token("TRON", "USDT").decimals).toBe(6);

    // Unknown triples throw — never a silent default.
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

  // Property 14 is enforced by the CI guard, not a unit test — see tooling/no-magic-constants.
  it.todo("[14] no chain id / address / rpc literal outside chain-config (CI guard)");
});
