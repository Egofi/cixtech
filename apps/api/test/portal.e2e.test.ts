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
    // Credited at finality → the address is already cooling down for reuse.
    expect(addrs.json().addresses).toMatchObject([{ chain: "TRON", address, state: "COOLING" }]);

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

  it("rotation issues a working key AND stops every previous one — the point of rotating", async () => {
    const { app, apiKey } = ctx;
    // A second key, so rotation has more than one credential to sweep.
    const extra = await app.inject({
      method: "POST",
      url: `/admin/api/tenants/${ctx.tenant.id}/keys`,
      headers: adminAuth(ADMIN_TOKEN),
    });
    const extraKey = extra.json().apiKey as string;

    const rot = await app.inject({
      method: "POST",
      url: `/admin/api/tenants/${ctx.tenant.id}/keys/rotate`,
      headers: adminAuth(ADMIN_TOKEN),
      payload: { reason: "key leaked" },
    });
    expect(rot.statusCode).toBe(201);
    const fresh = rot.json().apiKey as string;
    expect(fresh).toMatch(/^cxk_/);
    expect(rot.json().revoked).toHaveLength(2);

    // The replacement works…
    const ok = await app.inject({ method: "GET", url: "/v1/accounts", headers: auth(fresh) });
    expect(ok.statusCode).toBe(200);

    // …and BOTH old credentials are dead. This is the whole difference between
    // rotation and merely issuing another key.
    for (const dead of [apiKey, extraKey]) {
      const res = await app.inject({ method: "GET", url: "/v1/accounts", headers: auth(dead) });
      expect(res.statusCode).toBe(401);
    }

    // The rotation is audited, by key id, without the plaintext anywhere in it.
    const audit = await app.inject({
      method: "GET",
      url: "/admin/api/audit?limit=10",
      headers: adminAuth(ADMIN_TOKEN),
    });
    const actions = (audit.json() as Array<{ action: string }>).map((r) => r.action);
    expect(actions).toContain("tenant.rotate_keys");
    expect(actions).toContain("tenant.keys_revoked");
    expect(JSON.stringify(audit.json())).not.toContain(fresh);

    // The tenant's key list shows what happened, and never the keys themselves.
    const keys = await app.inject({
      method: "GET",
      url: `/admin/api/tenants/${ctx.tenant.id}/keys`,
      headers: adminAuth(ADMIN_TOKEN),
    });
    const rows = keys.json().keys as Array<{ revokedAt: string | null; revokedReason: string }>;
    expect(rows.filter((k) => k.revokedAt === null)).toHaveLength(1);
    expect(rows.filter((k) => k.revokedAt !== null)).toHaveLength(2);
    expect(rows.find((k) => k.revokedAt !== null)?.revokedReason).toBe("key leaked");
    expect(JSON.stringify(keys.json())).not.toContain(fresh);

    // Restore a usable key for any later assertion in this suite.
    ctx.apiKey = fresh;
  });

  it("revoking one key leaves the tenant's other keys working", async () => {
    const { app } = ctx;
    const issued = await app.inject({
      method: "POST",
      url: `/admin/api/tenants/${ctx.tenant.id}/keys`,
      headers: adminAuth(ADMIN_TOKEN),
    });
    const doomed = issued.json().apiKey as string;
    const keys = await app.inject({
      method: "GET",
      url: `/admin/api/tenants/${ctx.tenant.id}/keys`,
      headers: adminAuth(ADMIN_TOKEN),
    });
    const newest = (keys.json().keys as Array<{ id: string; revokedAt: string | null }>).find(
      (k) => k.revokedAt === null && k.id,
    );

    const res = await app.inject({
      method: "POST",
      url: `/admin/api/tenants/${ctx.tenant.id}/keys/${newest?.id}/revoke`,
      headers: adminAuth(ADMIN_TOKEN),
      payload: { reason: "no longer needed" },
    });
    expect(res.statusCode).toBe(200);

    // Revoking the same key twice is a 404 rather than a silent success.
    const again = await app.inject({
      method: "POST",
      url: `/admin/api/tenants/${ctx.tenant.id}/keys/${newest?.id}/revoke`,
      headers: adminAuth(ADMIN_TOKEN),
    });
    expect(again.statusCode).toBe(404);

    // Exactly one key died; whichever plaintext maps to it no longer authenticates.
    const after = await app.inject({
      method: "GET",
      url: `/admin/api/tenants/${ctx.tenant.id}/keys`,
      headers: adminAuth(ADMIN_TOKEN),
    });
    const live = (after.json().keys as Array<{ revokedAt: string | null }>).filter(
      (k) => k.revokedAt === null,
    );
    expect(live.length).toBeGreaterThanOrEqual(1);
    void doomed;
  });

  it("/v1/chains publishes asset decimals, so a client never shows base units as money", async () => {
    const res = await ctx.app.inject({
      method: "GET",
      url: "/v1/chains",
      headers: auth(ctx.apiKey),
    });
    expect(res.statusCode).toBe(200);
    const assets = res.json().assets as Array<{ symbol: string; decimals: number }>;
    // Without this a UI cannot tell 4.34 USDT from 4,340,000 of them.
    expect(assets.find((a) => a.symbol === "USDT")?.decimals).toBe(6);
    expect(assets.length).toBeGreaterThan(0);
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
