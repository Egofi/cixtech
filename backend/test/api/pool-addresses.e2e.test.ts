import { describe, expect, it } from "vitest";
import { adminAuth, auth, makeApi } from "./harness.js";

async function seedAddress(ctx: Awaited<ReturnType<typeof makeApi>>) {
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

describe("the pool address explorer", () => {
  it("lists every address the engine controls", async () => {
    const ctx = await makeApi();
    const { address, accountId } = await seedAddress(ctx);

    const res = await ctx.app.inject({
      method: "GET",
      url: "/admin/api/pool-addresses",
      headers: adminAuth(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(1);
    expect(body.addresses[0]).toMatchObject({
      address,
      merchant: accountId,
      chain: "TRON",
      derivationIndex: 0,
    });
  });

  it("reports an unobserved balance as absent rather than zero", async () => {
    const ctx = await makeApi();
    await seedAddress(ctx);

    const res = await ctx.app.inject({
      method: "GET",
      url: "/admin/api/pool-addresses",
      headers: adminAuth(),
    });

    expect(res.json().addresses[0].balanceBaseUnits).toBeNull();
    expect(res.json().addresses[0].observedAt).toBeNull();
  });

  it("surfaces the cached balance and its age once observed", async () => {
    const ctx = await makeApi();
    const { address } = await seedAddress(ctx);
    await ctx.sql.query(
      `INSERT INTO pool_address_balance (chain, address, asset, balance_base_units, source)
       VALUES ('TRON', $1, 'USDT', 4200000, 'test')`,
      [address],
    );

    const res = await ctx.app.inject({
      method: "GET",
      url: "/admin/api/pool-addresses",
      headers: adminAuth(),
    });

    const row = res.json().addresses[0];
    expect(row.balanceBaseUnits).toBe("4200000");
    expect(row.observedAt).toEqual(expect.any(String));
  });

  it("reports the group's ledger-versus-chain drift", async () => {
    const ctx = await makeApi();
    const { address } = await seedAddress(ctx);

    await ctx.sql.query(
      `INSERT INTO pool_address_balance (chain, address, asset, balance_base_units, source)
       VALUES ('TRON', $1, 'USDT', 4200000, 'test')`,
      [address],
    );

    const res = await ctx.app.inject({
      method: "GET",
      url: "/admin/api/pool-addresses",
      headers: adminAuth(),
    });

    const group = res.json().groups[0];
    expect(group.driftBaseUnits).toBe("4200000");
    expect(group.fullyObserved).toBe(true);
  });

  it("filters to funded addresses only", async () => {
    const ctx = await makeApi();
    await seedAddress(ctx);

    const res = await ctx.app.inject({
      method: "GET",
      url: "/admin/api/pool-addresses?funded=true",
      headers: adminAuth(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().addresses).toEqual([]);
  });

  it("is refused without an admin token", async () => {
    const ctx = await makeApi();
    const res = await ctx.app.inject({ method: "GET", url: "/admin/api/pool-addresses" });
    expect(res.statusCode).toBe(401);
  });
});

describe("collecting the fee", () => {
  it("refuses when no fee treasury address is configured", async () => {
    const ctx = await makeApi();
    const res = await ctx.app.inject({
      method: "POST",
      url: "/admin/api/earnings/sweep",
      headers: { ...adminAuth(), "content-type": "application/json" },
      payload: { asset: "USDT" },
    });

    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.json().error.message).toMatch(/treasury/i);
  });

  it("audits the attempt even when it fails", async () => {
    const ctx = await makeApi();
    await ctx.app.inject({
      method: "POST",
      url: "/admin/api/earnings/sweep",
      headers: { ...adminAuth(), "content-type": "application/json" },
      payload: { asset: "USDT" },
    });

    const { rows } = await ctx.sql.query<{ action: string; result: string }>(
      "SELECT action, result FROM admin_audit WHERE action = 'earnings.sweep_fees'",
    );
    expect(rows[0]).toMatchObject({ action: "earnings.sweep_fees", result: "error" });
  });
});
