import { describe, expect, it } from "vitest";
import { assertCustodyModelAcknowledged, assertPolicyConfigured } from "../src/policy-config.js";
import { SCOPES, parseScopes } from "../src/stores.js";
import { isPrivateAddress } from "../src/webhook-url.js";
import { adminAuth, auth, makeApi } from "./harness.js";

/**
 * The controls the security review (docs/SECURITY_AUDIT.md) found missing. Each
 * test names the finding it pins down, so a regression says which guarantee it
 * broke rather than only which assertion failed.
 */

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
      // And the message says what the absence would actually mean at runtime.
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
    // CX-20: the id is a UUID, not 46 bits of Math.random().
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

    // The point of the boundary: it can approve, and it cannot move funds.
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
      // The hex spelling the WHATWG URL parser normalises v4-mapped forms to.
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

    // 32 chars, passes minLength/maxLength, is not a valid Tron address.
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
