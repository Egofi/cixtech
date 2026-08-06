import { FxRateEngine, FxRateExpiredError, OfframpProvider } from "@cixtech/chains";
import { CheckoutModal } from "@cixtech/checkout";
import { describe, expect, it } from "vitest";
import { RecoveryService } from "../src/checkout/recovery-service.js";
import { auth, makeApi } from "./harness.js";

describe("Phase 2: FX Rate Engine (US-FX-01)", () => {
  it("calculates 15-minute guaranteed price lock quotes with 0.5% spread buffer", () => {
    const fx = new FxRateEngine({ spreadBps: 50 }); // 0.5%
    const now = new Date();
    const quote = fx.createQuote("USD", 100, "USDT", now);

    expect(quote.fiatCurrency).toBe("USD");
    expect(quote.fiatAmount).toBe("100.00");
    expect(quote.cryptoAsset).toBe("USDT");
    expect(quote.guaranteedSpreadBps).toBe(50);
    expect(quote.expiresAt.getTime() - quote.lockedAt.getTime()).toBe(900_000); // 15 mins
    expect(fx.isValid(quote, now)).toBe(true);
  });

  it("detects expired FX rate quotes past 900 seconds", () => {
    const fx = new FxRateEngine();
    const lockedAt = new Date("2026-08-05T12:00:00Z");
    const quote = fx.createQuote("USD", 100, "USDT", lockedAt);

    const pastExpiry = new Date("2026-08-05T12:16:00Z"); // 16 mins later
    expect(fx.isValid(quote, pastExpiry)).toBe(false);
    expect(() => fx.assertValid(quote, pastExpiry)).toThrow(FxRateExpiredError);
  });
});

describe("Phase 2: Checkout Payment Intents API", () => {
  it("creates a payment intent and returns payment URL & dynamic QR payload", async () => {
    const ctx = await makeApi();

    const acc = await ctx.app.inject({
      method: "POST",
      url: "/v1/accounts",
      headers: auth(ctx.apiKey),
      payload: { externalRef: "m-101" },
    });
    const merchantId = acc.json().id as string;

    const res = await ctx.app.inject({
      method: "POST",
      url: "/v1/checkout/intents",
      headers: auth(ctx.apiKey),
      payload: {
        merchantId,
        amountFiat: 150.0,
        fiatCurrency: "USD",
        cryptoAsset: "USDT",
        chain: "TRON",
        offrampChannel: "BANK_NIBSS",
        offrampAccount: "0123456789",
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.intent.id).toMatch(/^pi_/);
    expect(body.intent.amountFiat).toBe("150.00");
    expect(body.intent.cryptoAsset).toBe("USDT");
    expect(body.intent.status).toBe("PENDING");
    expect(body.paymentUrl).toContain(`/checkout/${body.intent.id}`);
    expect(body.qrPayload).toContain("tron:");

    // Public lookup endpoint
    const pub = await ctx.app.inject({
      method: "GET",
      url: `/v1/checkout/intents/${body.intent.id}`,
    });
    expect(pub.statusCode).toBe(200);
    expect(pub.json().intent.id).toBe(body.intent.id);
    expect(pub.json().remainingSeconds).toBeGreaterThan(800);
  });

  it("submits payment transaction hash and marks intent as PAID", async () => {
    const ctx = await makeApi();

    const acc = await ctx.app.inject({
      method: "POST",
      url: "/v1/accounts",
      headers: auth(ctx.apiKey),
      payload: {},
    });
    const merchantId = acc.json().id as string;

    const intent = await ctx.app.inject({
      method: "POST",
      url: "/v1/checkout/intents",
      headers: auth(ctx.apiKey),
      payload: {
        merchantId,
        amountFiat: 50.0,
        fiatCurrency: "USD",
        cryptoAsset: "USDT",
        chain: "TRON",
      },
    });
    const intentId = intent.json().intent.id as string;

    const pay = await ctx.app.inject({
      method: "POST",
      url: `/v1/checkout/intents/${intentId}/pay`,
      payload: { txHash: "0xdeadbeef1234567890" },
    });

    expect(pay.statusCode).toBe(200);
    expect(pay.json().status).toBe("PAID");
    expect(pay.json().intent.txHash).toBe("0xdeadbeef1234567890");
  });

  it("serves hosted checkout HTML page", async () => {
    const ctx = await makeApi();
    const acc = await ctx.app.inject({
      method: "POST",
      url: "/v1/accounts",
      headers: auth(ctx.apiKey),
      payload: {},
    });
    const merchantId = acc.json().id as string;

    const intent = await ctx.app.inject({
      method: "POST",
      url: "/v1/checkout/intents",
      headers: auth(ctx.apiKey),
      payload: {
        merchantId,
        amountFiat: 25.0,
        fiatCurrency: "USD",
        cryptoAsset: "USDT",
        chain: "TRON",
      },
    });
    const intentId = intent.json().intent.id as string;

    const page = await ctx.app.inject({
      method: "GET",
      url: `/checkout/${intentId}`,
    });

    expect(page.statusCode).toBe(200);
    expect(page.headers["content-type"]).toContain("text/html");
    expect(page.body).toContain("15-Min Guaranteed Price Lock");
  });
});

describe("Phase 2: Stranded Token Recovery (US-CHK-02)", () => {
  it("registers an unallocated deposit and allows customer self-service recovery claim", async () => {
    const ctx = await makeApi();
    const recovery = new RecoveryService(ctx.sql);

    await recovery.registerUnallocated({
      tenantId: ctx.tenant.id,
      chain: "TRON",
      depositAddress: "TAddrWrong123",
      txHash: "tx_wrong_999",
      asset: "USDT",
      amountBaseUnits: 100_000_000n,
    });

    const res = await ctx.app.inject({
      method: "POST",
      url: "/v1/checkout/recovery/claim",
      payload: {
        chain: "TRON",
        txHash: "tx_wrong_999",
        destinationAddress: "TTetbYe8bRMfz6ASefJACCb2gSzwbe9AqW",
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().deposit.status).toBe("CLAIMED");
    expect(res.json().deposit.claimedDestination).toBe("TTetbYe8bRMfz6ASefJACCb2gSzwbe9AqW");
  });
});

describe("Phase 2: Local Fiat & Mobile Money Off-Ramping (US-FX-02)", () => {
  it("dispatches instant local bank payout and mobile money M-Pesa push", async () => {
    const offramp = new OfframpProvider();

    const nibss = await offramp.dispatch({
      tenantId: "t1",
      merchantId: "m1",
      cryptoAsset: "USDT",
      amountBaseUnits: 50_000_000n,
      targetCurrency: "NGN",
      destination: {
        channel: "BANK_NIBSS",
        accountNumber: "0123456789",
        accountName: "Acme Nigeria Ltd",
        country: "NG",
      },
      idempotencyKey: "off_ngn_1",
    });

    expect(nibss.status).toBe("DISPATCHED");
    expect(nibss.channel).toBe("BANK_NIBSS");
    expect(nibss.estimatedArrivalSeconds).toBe(30);

    const mpesa = await offramp.dispatch({
      tenantId: "t1",
      merchantId: "m1",
      cryptoAsset: "USDT",
      amountBaseUnits: 20_000_000n,
      targetCurrency: "KES",
      destination: {
        channel: "MOBILE_MONEY_MPESA",
        accountNumber: "+254712345678",
        accountName: "Jane Doe",
        country: "KE",
      },
      idempotencyKey: "off_kes_1",
    });

    expect(mpesa.status).toBe("DISPATCHED");
    expect(mpesa.channel).toBe("MOBILE_MONEY_MPESA");
  });
});

describe("Phase 2: CheckoutModal SDK", () => {
  it("detects wallet providers and builds dynamic QR payloads", () => {
    const modal = new CheckoutModal();
    const wallets = modal.detectWallets();
    expect(Array.isArray(wallets)).toBe(true);

    const qr = modal.generateQrPayload({
      id: "pi_123",
      amountFiat: "100.00",
      fiatCurrency: "USD",
      cryptoAsset: "USDT",
      amountCryptoFormatted: "100.000000",
      amountCryptoBaseUnits: "100000000",
      chain: "TRON",
      depositAddress: "TAddr123",
      expiresAt: new Date().toISOString(),
      status: "PENDING",
    });

    expect(qr).toContain("tron:TAddr123?amount=100.000000");
  });
});
