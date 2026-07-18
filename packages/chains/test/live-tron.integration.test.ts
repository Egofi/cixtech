import { HDKey } from "@scure/bip32";
import { describe, expect, it } from "vitest";
import { FetchHttpClient } from "../src/http.js";
import { TronAdapter } from "../src/tron/tron-adapter.js";

// Gated: runs only when TRONGRID_API_KEY is set, so normal CI never hits the
// network. Proves the production path — FetchHttpClient → live TronGrid → Zod
// parse → ChainDeposit — against real data. Defaults to mainnet (where the key
// and continuous USDT flow live); a testnet run points TRON_RPC_URL at Nile.
const KEY = process.env["TRONGRID_API_KEY"];

// The USDT-TRC20 contract receives inbound transfers continuously — a reliable
// live target that always has parseable data.
const USDT_CONTRACT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";

describe.skipIf(!KEY)("LIVE TronGrid (gated on TRONGRID_API_KEY)", () => {
  const adapter = new TronAdapter(new FetchHttpClient(), {
    baseUrl: process.env["TRON_RPC_URL"] ?? "https://api.trongrid.io",
    confirmations: 19,
    ...(KEY ? { apiKey: KEY } : {}),
  });

  it("fetches and parses real inbound TRC20 transfers", async () => {
    const deposits = await adapter.fetchInboundTrc20(USDT_CONTRACT);
    expect(deposits.length).toBeGreaterThan(0);
    for (const d of deposits) {
      expect(d.chain).toBe("TRON");
      expect(d.to).toBe(USDT_CONTRACT);
      expect(typeof d.amountBaseUnits).toBe("bigint");
      expect(d.amountBaseUnits).toBeGreaterThan(0n);
      expect(d.txId).toMatch(/^[0-9a-f]{64}$/);
    }
  }, 20_000);

  it("queries one of our own derived addresses without error", async () => {
    const seed = Uint8Array.from(Buffer.from("000102030405060708090a0b0c0d0e0f", "hex"));
    const xpub = HDKey.fromMasterSeed(seed).derive("m/44'/195'/0'").publicExtendedKey;
    const deposits = await adapter.fetchInboundTrc20(adapter.deriveAddress(xpub, 0));
    expect(Array.isArray(deposits)).toBe(true); // a fresh address is typically empty
  }, 20_000);
});
