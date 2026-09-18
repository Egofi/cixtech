import {
  assertCustodyModelAcknowledged,
  assertPolicyConfigured,
  resolveTrustProxy,
} from "@/api/policy-config.js";
import { parseScopes } from "@/stores";
import { SCOPES } from "@/types";

import { isPrivateAddress } from "@/api/webhook-url.js";
import { describe, expect, it } from "vitest";
import { adminAuth, auth, makeApi } from "./harness.js";

describe("CX-04 — money-out guardrails must be configured on mainnet", () => {
  const full = {
    CIXTECH_POLICY_KEY: "k",
    CIXTECH_APPROVAL_THRESHOLD: "1",
    CIXTECH_APPROVAL_REQUIRED: "1",
    CIXTECH_TIMELOCK_THRESHOLD: "1",
    CIXTECH_TIMELOCK_DELAY_MS: "1",
    CIXTECH_MAX_PAYOUT: "1",
    CIXTECH_VELOCITY_MAX: "1",
    CIXTECH_VELOCITY_WINDOW_MS: "1",
  };

  it("refuses to boot on mainnet when a control is unset", () => {
    process.env["CHAIN_ENV"] = "mainnet";
    try {
      const { CIXTECH_POLICY_KEY: _dropped, ...missingPolicyKey } = full;
      expect(() => assertPolicyConfigured(missingPolicyKey)).toThrow(/payout authorization token/);

      expect(() => assertPolicyConfigured(missingPolicyKey)).toThrow(/no authorization binding/);
    } finally {
      process.env["CHAIN_ENV"] = "testnet";
    }
  });

  it("boots on mainnet once everything is configured", () => {
    process.env["CHAIN_ENV"] = "mainnet";
    try {
      expect(assertPolicyConfigured(full)).toEqual({ enforced: true, missing: [] });
    } finally {
      process.env["CHAIN_ENV"] = "testnet";
    }
  });

  it("reports rather than throws on testnet, so a partial dev setup still runs", () => {
    process.env["CHAIN_ENV"] = "testnet";
    const report = assertPolicyConfigured({});
    expect(report.enforced).toBe(false);
    expect(report.missing.length).toBeGreaterThan(0);
  });
});

describe("CX-16 — a hot signing key on mainnet must be acknowledged", () => {
  it("refuses mainnet without the acknowledgement", () => {
    process.env["CHAIN_ENV"] = "mainnet";
    try {
      expect(() => assertCustodyModelAcknowledged({})).toThrow(/hot key|held in this process/i);
    } finally {
      process.env["CHAIN_ENV"] = "testnet";
    }
  });

  it("proceeds when the operator has recorded the decision", () => {
    process.env["CHAIN_ENV"] = "mainnet";
    try {
      expect(assertCustodyModelAcknowledged({ CIXTECH_ACKNOWLEDGE_HOT_KEY: "true" })).toEqual({
        model: "hot-key",
        acknowledged: true,
      });
    } finally {
      process.env["CHAIN_ENV"] = "testnet";
    }
  });
});

describe("CX-07 — AI routes enforce scopes", () => {
  it("refuses rule creation from a read-only key, and allows it with move-funds", async () => {
    const { app, engine } = await makeApi();
    const readOnly = await engine.tenants.createTenant("read-only", ["read"]);
    const mover = await engine.tenants.createTenant("mover", ["read", "move-funds"]);
    const rule = {
      name: "halt",
      conditionType: "BALANCE_BELOW",
      conditionThreshold: "1000",
      action: "PAUSE_WITHDRAWALS",
    };

    const denied = await app.inject({
      method: "POST",
      url: "/v1/ai/rules",
      headers: auth(readOnly.apiKey),
      payload: rule,
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe("FORBIDDEN_SCOPE");

    const allowed = await app.inject({
      method: "POST",
      url: "/v1/ai/rules",
      headers: auth(mover.apiKey),
      payload: rule,
    });
    expect(allowed.statusCode).toBe(201);

    expect(allowed.json().rule.id).toMatch(/^rule_[0-9a-f-]{36}$/);
  });

  it("still lets a read-only key read the AI surface", async () => {
    const { app, engine } = await makeApi();
    const readOnly = await engine.tenants.createTenant("reader", ["read"]);
    for (const url of ["/v1/ai/anomalies", "/v1/ai/rules"]) {
      const res = await app.inject({ method: "GET", url, headers: auth(readOnly.apiKey) });
      expect(res.statusCode).toBe(200);
    }
  });

  it("rejects an unauthenticated AI request", async () => {
    const { app } = await makeApi();
    const res = await app.inject({ method: "GET", url: "/v1/ai/anomalies" });
    expect(res.statusCode).toBe(401);
  });
});

describe("CX-11 — the AI ledger query is tenant-scoped and no longer 500s", () => {
  it("answers the fall-through branch instead of throwing", async () => {
    const { app, apiKey } = await makeApi();
    const res = await app.inject({
      method: "POST",
      url: "/v1/ai/query",
      headers: auth(apiKey),
      payload: { prompt: "show me recent transactions" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().response.intent).toBe("TRANSACTION_HISTORY");
  });

  it("does not return another tenant's journal entries", async () => {
    const { app, engine, apiKey } = await makeApi();
    await engine.sql.query(
      `INSERT INTO journal_entry (id, kind, occurred_at, idempotency_key)
       VALUES ($1,$2,now(),$3)`,
      ["other-tenant-entry", "deposit.finalized", "other-tenant-idem"],
    );
    const res = await app.inject({
      method: "POST",
      url: "/v1/ai/query",
      headers: auth(apiKey),
      payload: { prompt: "show me recent transactions" },
    });
    const ids = (res.json().response.data as Array<{ id: string }>).map((r) => r.id);
    expect(ids).not.toContain("other-tenant-entry");
  });

  it("rejects a non-numeric rule threshold at the edge (CX-21)", async () => {
    const { app, apiKey } = await makeApi();
    const res = await app.inject({
      method: "POST",
      url: "/v1/ai/rules",
      headers: auth(apiKey),
      payload: {
        name: "bad",
        conditionType: "BALANCE_BELOW",
        conditionThreshold: "not-a-number",
        action: "NOTIFY",
      },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("CX-10 — keys can be issued with a restricted scope set", () => {
  it("issues an approve-only credential through the admin plane", async () => {
    const { app, engine } = await makeApi();
    const created = await app.inject({
      method: "POST",
      url: "/admin/api/tenants",
      headers: adminAuth(),
      payload: { name: "bank" },
    });
    const tenantId = created.json().tenant.id as string;

    const issued = await app.inject({
      method: "POST",
      url: `/admin/api/tenants/${tenantId}/keys`,
      headers: adminAuth(),
      payload: { scopes: ["approve"], label: "approver" },
    });
    expect(issued.statusCode).toBe(201);
    expect(issued.json().scopes).toEqual(["approve"]);

    const resolved = await engine.tenants.authenticate(issued.json().apiKey);
    expect(resolved.scopes).toEqual(["approve"]);

    const denied = await app.inject({
      method: "POST",
      url: "/v1/accounts",
      headers: auth(issued.json().apiKey),
      payload: {},
    });
    expect(denied.statusCode).toBe(403);
  });

  it("rejects an unknown scope rather than silently granting all of them", async () => {
    const { app } = await makeApi();
    const created = await app.inject({
      method: "POST",
      url: "/admin/api/tenants",
      headers: adminAuth(),
      payload: { name: "x", scopes: ["read", "superuser"] },
    });
    expect(created.statusCode).toBe(400);
  });

  it("still defaults to every scope when none is asked for", () => {
    expect(parseScopes(undefined)).toEqual(SCOPES);
  });
});

describe("CX-09 — webhook URLs cannot point at internal hosts", () => {
  const cases = [
    "http://169.254.169.254/latest/meta-data/",
    "https://127.0.0.1/hook",
    "https://localhost/hook",
    "https://[::1]/hook",
    "https://10.0.0.5/hook",
    "https://192.168.1.1/hook",
    "https://172.16.0.1/hook",
    "https://[::ffff:169.254.169.254]/hook",
  ];

  it("refuses loopback, link-local and private targets", async () => {
    const { app, apiKey } = await makeApi();
    for (const url of cases) {
      const res = await app.inject({
        method: "PUT",
        url: "/v1/webhook",
        headers: auth(apiKey),
        payload: { url },
      });
      expect(res.statusCode, `${url} should be refused`).toBe(400);
    }
  });

  it("refuses plain http, embedded credentials, and infrastructure ports", async () => {
    const { app, apiKey } = await makeApi();
    for (const url of [
      "http://hooks.example.com/x",
      "https://user:pass@hooks.example.com/x",
      "https://hooks.example.com:5432/x",
      "https://hooks.example.com:6379/x",
    ]) {
      const res = await app.inject({
        method: "PUT",
        url: "/v1/webhook",
        headers: auth(apiKey),
        payload: { url },
      });
      expect(res.statusCode, `${url} should be refused`).toBe(400);
    }
  });

  it("accepts a normal https endpoint that has not resolved yet", async () => {
    const { app, apiKey } = await makeApi();
    const res = await app.inject({
      method: "PUT",
      url: "/v1/webhook",
      headers: auth(apiKey),
      payload: { url: "https://hooks.newco.example/cixtech" },
    });
    expect(res.statusCode).toBe(201);
  });

  it("classifies addresses correctly, including v4-mapped IPv6", () => {
    for (const ip of [
      "127.0.0.1",
      "169.254.169.254",
      "10.1.2.3",
      "192.168.0.1",
      "172.20.0.1",
      "100.64.0.1",
      "::1",
      "fe80::1",
      "fd00::1",
      "::ffff:127.0.0.1",
      "::ffff:169.254.169.254",

      "::ffff:a9fe:a9fe",
      "::ffff:7f00:1",
      "::ffff:c0a8:1",
    ]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:4700::1111"]) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });
});

describe("CX-17 — an allow-listed destination can be removed", () => {
  const DEST = "TTetbYe8bRMfz6ASefJACCb2gSzwbe9AqW";

  it("removes it, and reports 404 when it was never there", async () => {
    const { app, apiKey } = await makeApi();
    const acc = await app.inject({
      method: "POST",
      url: "/v1/accounts",
      headers: auth(apiKey),
      payload: {},
    });
    const id = acc.json().id as string;

    await app.inject({
      method: "POST",
      url: `/v1/accounts/${id}/allowlist`,
      headers: auth(apiKey),
      payload: { chain: "TRON", address: DEST },
    });
    const listed = await app.inject({ method: "GET", url: "/v1/allowlist", headers: auth(apiKey) });
    expect(listed.json().allowlist).toHaveLength(1);

    const removed = await app.inject({
      method: "DELETE",
      url: `/v1/accounts/${id}/allowlist?chain=TRON&address=${DEST}`,
      headers: auth(apiKey),
    });
    expect(removed.statusCode).toBe(200);

    const after = await app.inject({ method: "GET", url: "/v1/allowlist", headers: auth(apiKey) });
    expect(after.json().allowlist).toHaveLength(0);

    const again = await app.inject({
      method: "DELETE",
      url: `/v1/accounts/${id}/allowlist?chain=TRON&address=${DEST}`,
      headers: auth(apiKey),
    });
    expect(again.statusCode).toBe(404);
  });
});

describe("CX-23 — destinations are validated for their chain at the boundary", () => {
  it("refuses a malformed address on the allow-list, not deep in the broadcaster", async () => {
    const { app, apiKey } = await makeApi();
    const acc = await app.inject({
      method: "POST",
      url: "/v1/accounts",
      headers: auth(apiKey),
      payload: {},
    });
    const id = acc.json().id as string;

    const res = await app.inject({
      method: "POST",
      url: `/v1/accounts/${id}/allowlist`,
      headers: auth(apiKey),
      payload: { chain: "TRON", address: "TNotARealTronAddressAtAllXXXXXXXX" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("INVALID_DESTINATION");
  });
});

describe("CX-13 — security headers are present", () => {
  it("sets CSP, frame-ancestors and nosniff on the console", async () => {
    const { app } = await makeApi();
    const res = await app.inject({ method: "GET", url: "/admin" });
    const csp = res.headers["content-security-policy"] as string;
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("default-src 'self'");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });
});

describe("cross-origin access is allowlisted, never wildcarded", () => {
  const CONSOLE = "https://console.cixtech.example";

  it("allows a named console origin", async () => {
    const { app, apiKey } = await makeApi({ corsOrigins: [CONSOLE] });
    const res = await app.inject({
      method: "GET",
      url: "/v1/balances",
      headers: { ...auth(apiKey), origin: CONSOLE },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe(CONSOLE);

    expect(res.headers["access-control-allow-credentials"]).toBe("true");
  });

  it("does not echo an origin that was not allowlisted", async () => {
    const { app, apiKey } = await makeApi({ corsOrigins: [CONSOLE] });
    const res = await app.inject({
      method: "GET",
      url: "/v1/balances",
      headers: { ...auth(apiKey), origin: "https://evil.example" },
    });
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("sends no CORS headers at all when no origin is configured", async () => {
    const { app, apiKey } = await makeApi();
    const res = await app.inject({
      method: "GET",
      url: "/v1/balances",
      headers: { ...auth(apiKey), origin: CONSOLE },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("answers the preflight the consoles actually send", async () => {
    const { app } = await makeApi({ corsOrigins: [CONSOLE] });
    const res = await app.inject({
      method: "OPTIONS",
      url: "/v1/accounts/x/withdrawals",
      headers: {
        origin: CONSOLE,
        "access-control-request-method": "POST",
        "access-control-request-headers": "x-api-key,idempotency-key,content-type",
      },
    });
    expect(res.statusCode).toBeLessThan(300);
    const allowed = String(res.headers["access-control-allow-headers"] ?? "").toLowerCase();
    for (const h of ["x-api-key", "idempotency-key", "content-type", "authorization"]) {
      expect(allowed, `preflight must allow ${h}`).toContain(h);
    }
  });
});

describe("CX-12 — authentication failures are not persisted to the audit trail", () => {
  it("counts them without writing a row per anonymous request", async () => {
    const { app, engine } = await makeApi();
    const before = await engine.sql.query<{ n: string }>("SELECT count(*)::text n FROM error_log");
    for (let i = 0; i < 25; i++) {
      await app.inject({ method: "GET", url: "/v1/balances", headers: auth(`bad-${i}`) });
    }
    const after = await engine.sql.query<{ n: string }>("SELECT count(*)::text n FROM error_log");
    expect(Number(after.rows[0]?.n)).toBe(Number(before.rows[0]?.n));
  });
});

describe("CIXTECH_TRUST_PROXY decides what req.ip means", () => {
  // req.ip keys the per-IP limit on failed credentials (CX-08) and is recorded
  // in the sign-in log and admin audit. Behind the console proxy every request
  // arrives from nginx, so this flag is what keeps those pointing at the caller
  // -- and believing it while the API is separately reachable lets anyone forge
  // X-Forwarded-For and walk past the limit. Every ambiguous value fails closed.
  it("is off when unset, so the socket address is used", () => {
    expect(resolveTrustProxy({})).toBeUndefined();
  });

  it("is off when explicitly false, in any case", () => {
    expect(resolveTrustProxy({ CIXTECH_TRUST_PROXY: "false" })).toBeUndefined();
    expect(resolveTrustProxy({ CIXTECH_TRUST_PROXY: "FALSE" })).toBeUndefined();
    expect(resolveTrustProxy({ CIXTECH_TRUST_PROXY: "  " })).toBeUndefined();
  });

  it("trusts any upstream only on an explicit true", () => {
    expect(resolveTrustProxy({ CIXTECH_TRUST_PROXY: "true" })).toBe(true);
    expect(resolveTrustProxy({ CIXTECH_TRUST_PROXY: "True" })).toBe(true);
  });

  it("accepts an address or CIDR list", () => {
    expect(resolveTrustProxy({ CIXTECH_TRUST_PROXY: "172.16.0.0/12" })).toEqual(["172.16.0.0/12"]);
    expect(resolveTrustProxy({ CIXTECH_TRUST_PROXY: "10.0.0.1, ::1 ,172.18.0.0/16" })).toEqual([
      "10.0.0.1",
      "::1",
      "172.18.0.0/16",
    ]);
  });

  it("refuses a bare number rather than guessing what it meant", () => {
    // Fastify types trustProxy without hop counts; a number is neither an
    // address nor a CIDR, so it must not become one by accident.
    expect(resolveTrustProxy({ CIXTECH_TRUST_PROXY: "1" })).toBeUndefined();
    expect(resolveTrustProxy({ CIXTECH_TRUST_PROXY: "0" })).toBeUndefined();
    expect(resolveTrustProxy({ CIXTECH_TRUST_PROXY: "-1" })).toBeUndefined();
  });
});
