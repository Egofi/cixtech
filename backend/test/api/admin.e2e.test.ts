import { depositFinalized } from "@/ledger";
import { LedgerService } from "@/services";
import { SqlLedgerStore } from "@/stores";
import { Asset, IdempotencyKey, JournalEntryId, LedgerAccountKey } from "@/types";
import { describe, expect, it } from "vitest";
import { ADMIN_TOKEN, adminAuth, auth, makeApi } from "./harness.js";

async function seedDeposit(ctx: Awaited<ReturnType<typeof makeApi>>) {
  const acc = await ctx.app.inject({
    method: "POST",
    url: "/v1/accounts",
    headers: auth(ctx.apiKey),
    payload: {},
  });
  const accountId = acc.json().id as string;
  const addr = await ctx.app.inject({
    method: "POST",
    url: `/v1/accounts/${accountId}/deposit-addresses`,
    headers: auth(ctx.apiKey),
    payload: { chain: "TRON", asset: "USDT" },
  });
  return { accountId, address: addr.json().address as string };
}

describe("admin console API", () => {
  it("rejects the API without a valid bearer token", async () => {
    const ctx = await makeApi();
    const anon = await ctx.app.inject({ method: "GET", url: "/admin/api/overview" });
    expect(anon.statusCode).toBe(401);
    const wrong = await ctx.app.inject({
      method: "GET",
      url: "/admin/api/overview",
      headers: adminAuth("nope"),
    });
    expect(wrong.statusCode).toBe(401);
  });

  it("no longer serves the console — it ships as a separate deployable", async () => {
    const ctx = await makeApi();

    for (const url of ["/admin", "/admin/app.js", "/admin/styles.css"]) {
      const res = await ctx.app.inject({ method: "GET", url });
      expect(res.statusCode, `${url} should not be served by the API`).toBe(404);
    }

    const api = await ctx.app.inject({
      method: "GET",
      url: "/admin/api/overview",
      headers: adminAuth(),
    });
    expect(api.statusCode).toBe(200);
  });

  it("returns an overview with solvency, counts, and kill-switch state", async () => {
    const ctx = await makeApi();
    const res = await ctx.app.inject({
      method: "GET",
      url: "/admin/api/overview",
      headers: adminAuth(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.killSwitchEngaged).toBe(false);
    expect(body.counts.tenants).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(body.solvency)).toBe(true);
    expect(body.limits.maxPerPayout).toBe("1000000000");
  });

  it("engaging the kill-switch halts a tenant payout, and reset restores it", async () => {
    const ctx = await makeApi();
    const { accountId } = await seedDeposit(ctx);

    const engage = await ctx.app.inject({
      method: "POST",
      url: "/admin/api/killswitch/engage",
      headers: adminAuth(),
      payload: { reason: "drill" },
    });
    expect(engage.statusCode).toBe(200);
    expect(engage.json().engaged).toBe(true);

    const denied = await ctx.app.inject({
      method: "POST",
      url: `/v1/accounts/${accountId}/withdrawals`,
      headers: { ...auth(ctx.apiKey), "idempotency-key": "k1" },
      payload: {
        chain: "TRON",
        asset: "USDT",
        amount: "1000000",
        destination: "TTetbYe8bRMfz6ASefJACCb2gSzwbe9AqW",
      },
    });
    expect(denied.statusCode).toBe(403);

    const reset = await ctx.app.inject({
      method: "POST",
      url: "/admin/api/killswitch/reset",
      headers: adminAuth(),
    });
    expect(reset.json().engaged).toBe(false);
  });

  it("audits every control action, including the actor and target", async () => {
    const ctx = await makeApi();
    await ctx.app.inject({
      method: "POST",
      url: "/admin/api/killswitch/engage",
      headers: adminAuth(),
      payload: { reason: "audit-check" },
    });
    const audit = await ctx.app.inject({
      method: "GET",
      url: "/admin/api/audit",
      headers: adminAuth(),
    });
    const rows = audit.json() as Array<{ action: string; result: string; actor: string }>;
    const engage = rows.find((r) => r.action === "killswitch.engage");
    expect(engage).toBeTruthy();
    expect(engage?.result).toBe("ok");

    expect(engage?.actor).toBe("static-admin-token");
  });

  it("lists webhook deliveries and replays a dead-lettered one", async () => {
    const ctx = await makeApi();
    await ctx.engine.webhookEndpoints.set(ctx.tenant.id, "https://x.example/hook", "cxs_secret");
    const id = await ctx.engine.webhookOutbox.enqueue(ctx.tenant.id, "deposit.confirmed", { a: 1 });

    await ctx.sql.query("UPDATE webhook_delivery SET status = 'dead' WHERE id = $1", [id]);

    const list = await ctx.app.inject({
      method: "GET",
      url: "/admin/api/webhooks",
      headers: adminAuth(),
    });
    expect((list.json() as unknown[]).length).toBe(1);

    const replay = await ctx.app.inject({
      method: "POST",
      url: `/admin/api/webhooks/${id}/replay`,
      headers: adminAuth(),
    });
    expect(replay.statusCode).toBe(200);
    const after = await ctx.app.inject({
      method: "GET",
      url: `/admin/api/webhooks/${id}`,
      headers: adminAuth(),
    });
    expect(after.json().status).toBe("pending");
    expect(after.json().attempts).toBe(0);
  });

  it("provisions a tenant and returns its API key exactly once", async () => {
    const ctx = await makeApi();
    const res = await ctx.app.inject({
      method: "POST",
      url: "/admin/api/tenants",
      headers: adminAuth(),
      payload: { name: "new-merchant" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().apiKey).toMatch(/^cxk_/);

    const audit = await ctx.app.inject({
      method: "GET",
      url: "/admin/api/audit",
      headers: adminAuth(),
    });
    const row = (audit.json() as Array<{ action: string; params: string }>).find(
      (r) => r.action === "tenant.create",
    );
    expect(row?.params).toContain("new-merchant");
    expect(row?.params ?? "").not.toContain("cxk_");
  });

  it("returns platform earnings analysis summary and tenant breakdown", async () => {
    const ctx = await makeApi();
    const res = await ctx.app.inject({
      method: "GET",
      url: "/admin/api/earnings",
      headers: adminAuth(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.summary)).toBe(true);
    expect(Array.isArray(body.tenantBreakdown)).toBe(true);
    expect(Array.isArray(body.trends)).toBe(true);
  });

  it("verifies on-chain wallet balance and returns solvency status", async () => {
    const ctx = await makeApi();
    const { address } = await seedDeposit(ctx);

    const res = await ctx.app.inject({
      method: "GET",
      url: `/admin/api/wallets/verify-onchain?chain=TRON&address=${address}&asset=USDT`,
      headers: adminAuth(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.chain).toBe("TRON");
    expect(body.address).toBe(address);
    expect(body.asset).toBe("USDT");
    expect(body.explorerUrl).toContain("tronscan");
    expect(typeof body.ledgerBalance).toBe("string");
    expect(typeof body.onchainBalance).toBe("string");
    expect(["EXACT_MATCH", "SURPLUS", "DEFICIT", "UNAVAILABLE"]).toContain(body.status);
  });

  it("refuses to collect fees when there is nowhere to send them", async () => {
    const ctx = await makeApi();
    const ledger = new LedgerService(new SqlLedgerStore(ctx.sql));

    await ledger.post(
      depositFinalized({
        id: JournalEntryId("sweep-dep-1"),
        idempotencyKey: IdempotencyKey("sweep-dep-1"),
        asset: Asset("USDT"),
        amount: 1_000_000n,
        feeBasisPoints: 50,
        poolAddr: LedgerAccountKey("pool_addr:TRON:m1"),
        merchantAvailable: LedgerAccountKey(`merchant_available:${ctx.tenant.id}:m1`),
        feeRevenue: LedgerAccountKey(`egofi_fee_revenue:${ctx.tenant.id}`),
      }),
    );

    const sweep = await ctx.app.inject({
      method: "POST",
      url: "/admin/api/earnings/sweep",
      headers: adminAuth(),
      payload: { asset: "USDT" },
    });
    expect(sweep.statusCode).toBe(400);
    expect(sweep.json().error.code).toBe("FEE_TREASURY_NOT_CONFIGURED");

    const { rows } = await ctx.sql.query<{ n: string }>(
      "SELECT count(*) AS n FROM journal_entry WHERE kind = 'fee.swept'",
    );
    expect(rows[0]?.n).toBe("0");
  });
});
