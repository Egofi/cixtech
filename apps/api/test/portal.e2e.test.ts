import type { ChainDeposit } from "@cixtech/chains";
import type { FastifyInstance } from "fastify";
import { beforeEach, describe, expect, it } from "vitest";
import { ADMIN_TOKEN, DEST, adminAuth, auth, makeApi } from "./harness.js";

async function createAccount(app: FastifyInstance, apiKey: string, ref?: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/v1/accounts",
    headers: auth(apiKey),
    payload: ref ? { externalRef: ref } : {},
  });
  return res.json().id as string;
}

const depositTo = (address: string, txId = "tx-1"): ChainDeposit => ({
  chain: "TRON",
  txId,
  index: 0,
  to: address,
  from: "TSender",
  asset: "USDT",
  amountBaseUnits: 10_000_000n,
});

describe("tenant portal + activity APIs", () => {
  let ctx: Awaited<ReturnType<typeof makeApi>>;
  beforeEach(async () => {
    ctx = await makeApi();
  });

  it("serves the portal SPA shell, script, and styles without auth", async () => {
    const shell = await ctx.app.inject({ method: "GET", url: "/portal" });
    expect(shell.statusCode).toBe(200);
    expect(shell.headers["content-type"]).toContain("text/html");
    expect(shell.body).toContain("cixtech · dashboard");
    const js = await ctx.app.inject({ method: "GET", url: "/portal/app.js" });
    expect(js.statusCode).toBe(200);
    expect(js.body).toContain("cx_tenant_key");
    const css = await ctx.app.inject({ method: "GET", url: "/portal/styles.css" });
    expect(css.statusCode).toBe(200);
  });

  it("walks the activity surface: accounts, addresses, balances, deposits, payouts, allowlist, deliveries", async () => {
    const { app, engine, apiKey } = ctx;
    const accountId = await createAccount(app, apiKey, "merchant-1");

    // Accounts list shows it.
    const accounts = await app.inject({
      method: "GET",
      url: "/v1/accounts",
      headers: auth(apiKey),
    });
    expect(accounts.json().accounts).toMatchObject([{ id: accountId, externalRef: "merchant-1" }]);

    // Assign an address, land a deposit, watcher enqueues the webhook.
    const addrRes = await app.inject({
      method: "POST",
      url: `/v1/accounts/${accountId}/deposit-addresses`,
      headers: auth(apiKey),
      payload: { chain: "TRON", asset: "USDT" },
    });
    const address = addrRes.json().address as string;
    expect((await engine.ingestor.ingestConfirmed(depositTo(address))).status).toBe("credited");
    await engine.webhookOutbox.enqueue(ctx.tenant.id, "deposit.confirmed", { txId: "tx-1" });

    // Deposit addresses list shows the assigned address with its state.
    const addrs = await app.inject({
      method: "GET",
      url: `/v1/accounts/${accountId}/deposit-addresses`,
      headers: auth(apiKey),
    });
    expect(addrs.json().addresses).toMatchObject([{ chain: "TRON", address, state: "IN_USE" }]);

    // Balances across accounts (10M minus 0.5% fee).
    const bal = await app.inject({ method: "GET", url: "/v1/balances", headers: auth(apiKey) });
    expect(bal.json().balances).toMatchObject([{ accountId, asset: "USDT", available: "9950000" }]);

    // Deposit history shows the credit with the net amount.
    const deps = await app.inject({ method: "GET", url: "/v1/deposits", headers: auth(apiKey) });
    expect(deps.json().deposits).toMatchObject([
      { kind: "deposit.finalized", asset: "USDT", amount: "9950000", accountId },
    ]);

    // Allow-list DEST (static-set already allows it; the durable row records cool-down).
    const al = await app.inject({
      method: "POST",
      url: `/v1/accounts/${accountId}/allowlist`,
      headers: auth(apiKey),
      payload: { chain: "TRON", address: DEST },
    });
    expect(al.statusCode).toBe(201);
    const alList = await app.inject({ method: "GET", url: "/v1/allowlist", headers: auth(apiKey) });
    expect(alList.json().allowlist).toMatchObject([{ accountId, chain: "TRON", address: DEST }]);
    expect(alList.json().allowlist[0].usableAt).toBeTruthy();

    // Request a payout (DEST is in the harness's static allow-list), then it appears in history.
    const pay = await app.inject({
      method: "POST",
      url: `/v1/accounts/${accountId}/withdrawals`,
      headers: { ...auth(apiKey), "idempotency-key": "w1" },
      payload: { chain: "TRON", asset: "USDT", amount: "1000000", destination: DEST },
    });
    expect(pay.statusCode).toBe(200);
    const payouts = await app.inject({ method: "GET", url: "/v1/payouts", headers: auth(apiKey) });
    expect(payouts.json().payouts).toMatchObject([
      { accountId, chain: "TRON", asset: "USDT", amount: "1000000", status: "settled" },
    ]);

    // Webhook endpoint config + delivery history.
    const wh = await app.inject({
      method: "PUT",
      url: "/v1/webhook",
      headers: auth(apiKey),
      payload: { url: "https://tenant.example/hooks" },
    });
    expect(wh.statusCode).toBe(201);
    const whGet = await app.inject({ method: "GET", url: "/v1/webhook", headers: auth(apiKey) });
    expect(whGet.json()).toEqual({ url: "https://tenant.example/hooks" });
    const del = await app.inject({
      method: "GET",
      url: "/v1/webhook/deliveries",
      headers: auth(apiKey),
    });
    expect(del.json().deliveries).toMatchObject([
      { event: "deposit.confirmed", status: "pending" },
    ]);
  });

  it("isolates every activity endpoint between tenants", async () => {
    const { app, engine, apiKey } = ctx;
    // Tenant A gets an account, a deposit, a payout intent, an allowlist row, a delivery.
    const accountId = await createAccount(app, apiKey, "a-merchant");
    const addrRes = await app.inject({
      method: "POST",
      url: `/v1/accounts/${accountId}/deposit-addresses`,
      headers: auth(apiKey),
      payload: { chain: "TRON", asset: "USDT" },
    });
    await engine.ingestor.ingestConfirmed(depositTo(addrRes.json().address as string));
    await engine.webhookOutbox.enqueue(ctx.tenant.id, "deposit.confirmed", {});
    await app.inject({
      method: "POST",
      url: `/v1/accounts/${accountId}/allowlist`,
      headers: auth(apiKey),
      payload: { chain: "TRON", address: DEST },
    });
    await app.inject({
      method: "POST",
      url: `/v1/accounts/${accountId}/withdrawals`,
      headers: { ...auth(apiKey), "idempotency-key": "w1" },
      payload: { chain: "TRON", asset: "USDT", amount: "1000000", destination: DEST },
    });

    // Tenant B sees NONE of it, on every endpoint.
    const { apiKey: keyB } = await engine.tenants.createTenant("intruder");
    for (const url of [
      "/v1/accounts",
      "/v1/balances",
      "/v1/deposits",
      "/v1/payouts",
      "/v1/allowlist",
      "/v1/webhook/deliveries",
    ]) {
      const res = await app.inject({ method: "GET", url, headers: auth(keyB) });
      expect(res.statusCode).toBe(200);
      const body = res.json() as Record<string, unknown[]>;
      const listKey = Object.keys(body)[0] as string;
      expect(body[listKey], `${url} must be empty for tenant B`).toEqual([]);
    }
    // And tenant B cannot read tenant A's account-scoped lists.
    const stolen = await app.inject({
      method: "GET",
      url: `/v1/accounts/${accountId}/deposit-addresses`,
      headers: auth(keyB),
    });
    expect(stolen.statusCode).toBe(404);
  });

  it("admin can issue an additional API key that works (lost-key recovery), audited", async () => {
    const { app, apiKey } = ctx;
    const rot = await app.inject({
      method: "POST",
      url: `/admin/api/tenants/${ctx.tenant.id}/keys`,
      headers: adminAuth(ADMIN_TOKEN),
    });
    expect(rot.statusCode).toBe(201);
    const newKey = rot.json().apiKey as string;
    expect(newKey).toMatch(/^cxk_/);
    expect(newKey).not.toBe(apiKey);

    // Both keys authenticate to the SAME tenant.
    for (const k of [apiKey, newKey]) {
      const res = await app.inject({ method: "GET", url: "/v1/accounts", headers: auth(k) });
      expect(res.statusCode).toBe(200);
    }
    // The issuance is audited — without leaking the key.
    const audit = await app.inject({
      method: "GET",
      url: "/admin/api/audit?limit=5",
      headers: adminAuth(ADMIN_TOKEN),
    });
    const row = (audit.json() as Array<{ action: string; target: string }>).find(
      (r) => r.action === "tenant.issue_key",
    );
    expect(row?.target).toBe(ctx.tenant.id);
    expect(JSON.stringify(audit.json())).not.toContain(newKey);
  });

  it("unknown tenant on key issuance is a 404, not a silent success", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/admin/api/tenants/nope/keys",
      headers: adminAuth(ADMIN_TOKEN),
    });
    expect(res.statusCode).toBe(404);
  });
});
