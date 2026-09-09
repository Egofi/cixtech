import { describe, expect, it } from "vitest";
import { adminAuth, makeApi } from "./harness.js";

describe("POST with a JSON content-type but no body", () => {
  it("releases the kill-switch, the control that had to be reversible", async () => {
    const ctx = await makeApi();
    await ctx.app.inject({
      method: "POST",
      url: "/admin/api/killswitch/engage",
      headers: { ...adminAuth(), "content-type": "application/json" },
      payload: { reason: "drill" },
    });

    const res = await ctx.app.inject({
      method: "POST",
      url: "/admin/api/killswitch/reset",
      headers: { ...adminAuth(), "content-type": "application/json" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().engaged).toBe(false);
  });

  it("issues a tenant key", async () => {
    const ctx = await makeApi();
    const res = await ctx.app.inject({
      method: "POST",
      url: `/admin/api/tenants/${ctx.tenant.id}/keys`,
      headers: { ...adminAuth(), "content-type": "application/json" },
    });
    expect(res.statusCode).toBe(201);
    expect(String(res.json().apiKey)).toMatch(/^cxk_/);
  });
});

describe("client errors keep their own status", () => {
  it("reports malformed JSON as a 400 that says so", async () => {
    const ctx = await makeApi();
    const res = await ctx.app.inject({
      method: "POST",
      url: "/admin/api/killswitch/engage",
      headers: { ...adminAuth(), "content-type": "application/json" },
      payload: "{ not json",
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).not.toBe("INTERNAL");
  });

  it("still hides genuine internal faults behind an opaque 500", async () => {
    const ctx = await makeApi();

    const realQuery = ctx.engine.sql.query.bind(ctx.engine.sql);
    ctx.engine.sql.query = ((sql: string, params?: unknown[]) => {
      if (String(sql).includes("admin_audit")) {
        return Promise.reject(new Error("secret internal detail"));
      }
      return realQuery(sql, params as never);
    }) as typeof ctx.engine.sql.query;

    const res = await ctx.app.inject({
      method: "GET",
      url: "/admin/api/audit",
      headers: adminAuth(),
    });
    ctx.engine.sql.query = realQuery;

    expect(res.statusCode).toBe(500);
    expect(res.json().error).toMatchObject({ code: "INTERNAL", message: "Internal error" });
    expect(res.body).not.toContain("secret internal detail");
  });
});
