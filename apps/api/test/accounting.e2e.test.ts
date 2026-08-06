import { ErpSyncService, LedgerExporter, resolveGaapMapping } from "@cixtech/accounting";
import { RefundService } from "@cixtech/chains";
import { depositFinalized, LedgerService, SqlLedgerStore } from "@cixtech/ledger";
import { Asset, IdempotencyKey, JournalEntryId, LedgerAccountKey } from "@cixtech/types";
import { describe, expect, it } from "vitest";
import { auth, makeApi } from "./harness.js";

describe("Phase 3: GAAP/IFRS Chart of Accounts & Exporter (US-ACC-01, US-ACC-02)", () => {
  it("maps internal ledger account keys to standard 4-digit GAAP GL codes", () => {
    expect(resolveGaapMapping("pool_addr:TRON:m1").glCode).toBe("1000");
    expect(resolveGaapMapping("merchant_available:t1:m1").glCode).toBe("2000");
    expect(resolveGaapMapping("egofi_fee_revenue:t1").glCode).toBe("4000");
    expect(resolveGaapMapping("treasury:PLATFORM").glCode).toBe("1010");
  });

  it("exports balanced General Ledger trial balance in QuickBooks CSV format", async () => {
    const ctx = await makeApi();
    const exporter = new LedgerExporter(ctx.sql);

    const report = await exporter.getTrialBalance(ctx.tenant.id);
    expect(report.tenantId).toBe(ctx.tenant.id);
    expect(report.isBalanced).toBe(true);

    const csv = await exporter.export(ctx.tenant.id, "QUICKBOOKS_CSV");
    expect(csv).toContain("JournalDate,GLCode,AccountName,Debit,Credit,Currency,Memo");

    const mt940 = await exporter.export(ctx.tenant.id, "MT940");
    expect(mt940).toContain(":20:CIXTECHEXPORT");
  });

  it("fetches accounting export via GET /v1/accounting/export API", async () => {
    const ctx = await makeApi();

    const res = await ctx.app.inject({
      method: "GET",
      url: "/v1/accounting/export?format=quickbooks",
      headers: auth(ctx.apiKey),
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.body).toContain("JournalDate,GLCode,AccountName");
  });

  it("triggers automated ERP sync via POST /v1/accounting/erp-sync API", async () => {
    const ctx = await makeApi();

    const res = await ctx.app.inject({
      method: "POST",
      url: "/v1/accounting/erp-sync",
      headers: auth(ctx.apiKey),
      payload: { target: "QUICKBOOKS_ONLINE" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.sync.status).toBe("SUCCESS");
    expect(body.sync.target).toBe("QUICKBOOKS_ONLINE");
  });
});

describe("Phase 3: Sub-Minute Automated Refund Engine (US-RFD-01)", () => {
  it("calculates network gas fee deduction and net refund amount", async () => {
    const refundService = new RefundService();

    const result = await refundService.processRefund({
      tenantId: "t1",
      merchantId: "m1",
      chain: "TRON",
      asset: "USDT",
      amountBaseUnits: 10_000_000n, // 10.00 USDT
      destinationAddress: "TTetbYe8bRMfz6ASefJACCb2gSzwbe9AqW",
      reason: "OVERPAYMENT",
      idempotencyKey: "rfd_test_1",
    });

    expect(result.grossAmountBaseUnits).toBe(10_000_000n);
    expect(result.gasDeductionBaseUnits).toBe(1_000_000n); // 1.00 USDT gas fee
    expect(result.netAmountBaseUnits).toBe(9_000_000n); // 9.00 USDT net refund
    expect(result.status).toBe("DISPATCHED");
  });

  it("triggers customer refund via POST /v1/refunds API and tracks record", async () => {
    const ctx = await makeApi();

    const acc = await ctx.app.inject({
      method: "POST",
      url: "/v1/accounts",
      headers: auth(ctx.apiKey),
      payload: {},
    });
    const merchantId = acc.json().id as string;

    const poolAddr = "TPoolAddr123456789012345678901234";

    // Insert pool address for merchant gather
    await ctx.sql.query(
      `INSERT INTO pool_address (id, chain, address, derivation_index, tenant, merchant, state)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      ["pa_ref_1", "TRON", poolAddr, 0, ctx.tenant.id, merchantId, "IN_USE"],
    );

    // Credit merchant ledger balance
    const ledger = new LedgerService(new SqlLedgerStore(ctx.sql));
    await ledger.post(
      depositFinalized({
        id: JournalEntryId("dep_ref_seed_1"),
        idempotencyKey: IdempotencyKey("dep_ref_seed_1"),
        asset: Asset("USDT"),
        amount: 50_000_000n, // 50 USDT
        feeBasisPoints: 0,
        poolAddr: LedgerAccountKey(`pool_addr:TRON:${merchantId}`),
        merchantAvailable: LedgerAccountKey(`merchant_available:${ctx.tenant.id}:${merchantId}`),
        feeRevenue: LedgerAccountKey(`egofi_fee_revenue:${ctx.tenant.id}`),
      }),
    );

    // Allowlist destination address for payout policy check
    await ctx.sql.query(
      `INSERT INTO payout_allowlist (tenant, merchant, chain, address, usable_at)
       VALUES ($1, $2, $3, $4, now() - interval '1 hour')`,
      [ctx.tenant.id, merchantId, "TRON", "TTetbYe8bRMfz6ASefJACCb2gSzwbe9AqW"],
    );

    const res = await ctx.app.inject({
      method: "POST",
      url: "/v1/refunds",
      headers: auth(ctx.apiKey),
      payload: {
        merchantId,
        chain: "TRON",
        asset: "USDT",
        amountBaseUnits: "15000000", // 15.00 USDT
        destinationAddress: "TTetbYe8bRMfz6ASefJACCb2gSzwbe9AqW",
        reason: "EXPIRED_INTENT",
        sponsorGas: true,
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.refund.id).toMatch(/^rfd_/);
    expect(body.refund.grossAmountBaseUnits).toBe("15000000");
    expect(body.refund.gasDeductionBaseUnits).toBe("0"); // Sponsored gas
    expect(body.refund.netAmountBaseUnits).toBe("15000000");
    expect(body.refund.reason).toBe("EXPIRED_INTENT");

    // Lookup refund
    const lookup = await ctx.app.inject({
      method: "GET",
      url: `/v1/refunds/${body.refund.id}`,
      headers: auth(ctx.apiKey),
    });

    expect(lookup.statusCode).toBe(200);
    expect(lookup.json().refund.id).toBe(body.refund.id);
  });
});
