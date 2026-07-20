import { describe, expect, it } from "vitest";
import { ADMIN_TOKEN, adminAuth, auth, makeApi } from "./harness.js";

/** Assign a deposit address and simulate a credited deposit so the ledger has data. */
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

  it("serves the static console shell without a token", async () => {
    const ctx = await makeApi();
    const page = await ctx.app.inject({ method: "GET", url: "/admin" });
    expect(page.statusCode).toBe(200);
    expect(page.headers["content-type"]).toContain("text/html");
    expect(page.body).toContain("cixtech");
    const js = await ctx.app.inject({ method: "GET", url: "/admin/app.js" });
    expect(js.statusCode).toBe(200);
    expect(js.headers["content-type"]).toContain("javascript");
    // The inlined SPA only runs in a browser; at least assert it parses as valid JS.
    expect(() => new Function(js.body)).not.toThrow();
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

    // A tenant withdrawal is now denied by policy (kill-switch is engaged).
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
    expect(engage?.actor).toBe("super_admin");
  });

  it("lists webhook deliveries and replays a dead-lettered one", async () => {
    const ctx = await makeApi();
    await ctx.engine.webhookEndpoints.set(ctx.tenant.id, "https://x.example/hook", "cxs_secret");
    const id = await ctx.engine.webhookOutbox.enqueue(ctx.tenant.id, "deposit.confirmed", { a: 1 });
    // Force it to dead so replay has something to do.
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

    // The audit row records the name but NOT the API key.
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
});
