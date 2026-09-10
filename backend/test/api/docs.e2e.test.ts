import { describe, expect, it } from "vitest";
import { makeApi } from "./harness.js";

describe("interactive API docs (Scalar)", () => {
  it("serves the reference UI at /docs without auth", async () => {
    const { app } = await makeApi();

    const bare = await app.inject({ method: "GET", url: "/docs" });
    expect(bare.statusCode).toBe(301);
    const res = await app.inject({ method: "GET", url: "/docs/" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
  });

  it("exposes the OpenAPI spec with the full tenant surface and API-key scheme", async () => {
    const { app } = await makeApi();
    const res = await app.inject({ method: "GET", url: "/docs/openapi.json" });
    expect(res.statusCode).toBe(200);
    const spec = res.json() as {
      info: { title: string; description?: string };
      paths: Record<string, unknown>;
      components: { securitySchemes: Record<string, { name?: string }> };
    };
    expect(spec.info.title).toBe("cixtech Custody API");
    expect(spec.info.description).toContain("x-api-key");

    for (const path of [
      "/v1/accounts",
      "/v1/accounts/{id}/deposit-addresses",
      "/v1/accounts/{id}/balance",
      "/v1/accounts/{id}/withdrawals",
      "/v1/accounts/{id}/allowlist",
      "/v1/balances",
      "/v1/deposits",
      "/v1/payouts",
      "/v1/allowlist",
      "/v1/chains",
      "/v1/webhook",
      "/v1/webhook/deliveries",
    ]) {
      expect(spec.paths[path], `${path} must be documented`).toBeDefined();
    }
    expect(spec.components.securitySchemes["apiKey"]?.name).toBe("x-api-key");
  });
});
