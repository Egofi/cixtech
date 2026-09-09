import { buildApp } from "@/api/app.js";
import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { adminAuth, auth, makeApi } from "./harness.js";

async function newAccount(app: FastifyInstance, apiKey: string): Promise<string> {
  const r = await app.inject({
    method: "POST",
    url: "/v1/accounts",
    headers: auth(apiKey),
    payload: {},
  });
  return r.json().id as string;
}

describe("API hardening", () => {
  it("validates requests against the route schema (400 VALIDATION)", async () => {
    const { app, apiKey } = await makeApi();
    const id = await newAccount(app, apiKey);

    const missing = await app.inject({
      method: "POST",
      url: `/v1/accounts/${id}/deposit-addresses`,
      headers: auth(apiKey),
      payload: { asset: "USDT" },
    });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error.code).toBe("VALIDATION");
    expect(missing.json().error.id).toMatch(/^[0-9a-f-]{36}$/);

    const extra = await app.inject({
      method: "POST",
      url: `/v1/accounts/${id}/deposit-addresses`,
      headers: auth(apiKey),
      payload: { chain: "TRON", asset: "USDT", oops: 1 },
    });
    expect(extra.statusCode).toBe(400);

    const badAmount = await app.inject({
      method: "POST",
      url: `/v1/accounts/${id}/withdrawals`,
      headers: { ...auth(apiKey), "idempotency-key": "k" },
      payload: {
        chain: "TRON",
        asset: "USDT",
        amount: "1.5",
        destination: "TTetbYe8bRMfz6ASefJACCb2gSzwbe9AqW",
      },
    });
    expect(badAmount.statusCode).toBe(400);
  });

  it("generates an OpenAPI spec and serves Swagger UI", async () => {
    const { app } = await makeApi();
    const spec = app.swagger() as { openapi?: string; paths: Record<string, unknown> };
    expect(spec.openapi).toMatch(/^3\./);
    expect(spec.paths["/v1/accounts"]).toBeDefined();
    expect(spec.paths["/v1/accounts/{id}/withdrawals"]).toBeDefined();

    const docs = await app.inject({ method: "GET", url: "/docs/" });
    expect(docs.statusCode).toBe(200);
  });

  it("reports readiness after a DB check", async () => {
    const { app } = await makeApi();
    const res = await app.inject({ method: "GET", url: "/ready" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ready" });
  });

  it("exposes Prometheus metrics to an authorised scraper, and nobody else", async () => {
    const { app, apiKey } = await makeApi();
    await newAccount(app, apiKey);

    const anonymous = await app.inject({ method: "GET", url: "/metrics" });
    expect(anonymous.statusCode).toBe(401);

    const res = await app.inject({ method: "GET", url: "/metrics", headers: adminAuth() });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("http_requests_total");
    expect(res.body).toContain("http_request_duration_seconds");
    expect(res.body).toContain('route="/v1/accounts"');
  });

  it("logs requests without leaking the API key", async () => {
    const { engine, apiKey } = await makeApi();
    const lines: string[] = [];
    const app = await buildApp(engine, {
      logger: { level: "info", stream: { write: (s: string) => lines.push(s) } },
    });
    await app.inject({ method: "POST", url: "/v1/accounts", headers: auth(apiKey), payload: {} });

    const out = lines.join("");
    expect(out).toContain("/v1/accounts");
    expect(out).not.toContain(apiKey);
  });
});
