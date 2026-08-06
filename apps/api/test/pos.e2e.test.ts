import { describe, expect, it } from "vitest";
import { auth, makeApi } from "./harness.js";

describe("Proof of Reserves & Retail POS Dynamic QR (US-CMP-02, US-POS-01)", () => {
  it("fetches cryptographic proof of reserves via GET /v1/proof-of-reserves", async () => {
    const ctx = await makeApi();

    const res = await ctx.app.inject({
      method: "GET",
      url: "/v1/proof-of-reserves",
      headers: auth(ctx.apiKey),
    });

    expect(res.statusCode).toBe(200);
    const por = res.json().proofOfReserves;
    expect(por.tenantId).toBe(ctx.tenant.id);
    expect(por.isSolvent).toBe(true);
    expect(por.coverageRatioPercentage).toBe("105.00%");
    expect(por.merkleTreeRootHash.length).toBe(64);
    expect(por.signature).toMatch(/^0xpor_/);
  });

  it("generates dynamic POS payment QR code and thermal receipt via POST /v1/pos/qr", async () => {
    const ctx = await makeApi();

    const acc = await ctx.app.inject({
      method: "POST",
      url: "/v1/accounts",
      headers: auth(ctx.apiKey),
      payload: {},
    });
    const merchantId = acc.json().id as string;

    const res = await ctx.app.inject({
      method: "POST",
      url: "/v1/pos/qr",
      headers: auth(ctx.apiKey),
      payload: {
        merchantId,
        terminalId: "TERM_001",
        fiatAmount: "15.50",
        fiatCurrency: "USD",
        chain: "TRON",
        asset: "USDT",
      },
    });

    expect(res.statusCode).toBe(201);
    const session = res.json().posSession;
    expect(session.id).toMatch(/^pos_/);
    expect(session.terminalId).toBe("TERM_001");
    expect(session.fiatAmount).toBe("15.50");
    expect(session.fiatCurrency).toBe("USD");
    expect(session.paymentAddress.startsWith("T")).toBe(true);
    expect(session.qrPayloadUri).toContain("tron:");
    expect(session.thermalReceiptSpec.storeHeader).toBe("CIXTech Retail POS Terminal");
  });
});
