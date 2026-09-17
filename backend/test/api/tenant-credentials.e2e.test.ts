import { describe, expect, it } from "vitest";
import { adminAuth, makeApi } from "./harness.js";

type Ctx = Awaited<ReturnType<typeof makeApi>>;

async function newTenant(ctx: Ctx, name: string, email: string) {
  const res = await ctx.app.inject({
    method: "POST",
    url: "/admin/api/tenants",
    headers: adminAuth(),
    payload: { name, ownerEmail: email },
  });
  expect(res.statusCode).toBe(201);
  return res.json() as {
    tenant: { id: string };
    apiKey: string;
    owner: { email: string; password: string };
  };
}

async function userIdOf(ctx: Ctx, tenantId: string) {
  const res = await ctx.app.inject({
    method: "GET",
    url: `/admin/api/tenants/${tenantId}/users`,
    headers: adminAuth(),
  });
  return res.json().users[0].id as string;
}

/** Sign in far enough to prove the password is accepted (admin roles stop at MFA). */
async function passwordAccepted(ctx: Ctx, email: string, password: string) {
  const res = await ctx.app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { email, password, kind: "tenant_user" },
  });
  return res.statusCode === 200;
}

describe("a tenant's human credentials can be rotated", () => {
  it("issues a new one-time password and refuses the old one", async () => {
    const ctx = await makeApi();
    const t = await newTenant(ctx, "Rotate", "owner@rotate.test");
    const userId = await userIdOf(ctx, t.tenant.id);

    expect(await passwordAccepted(ctx, t.owner.email, t.owner.password)).toBe(true);

    const reset = await ctx.app.inject({
      method: "POST",
      url: `/admin/api/tenants/${t.tenant.id}/users/${userId}/reset-password`,
      headers: adminAuth(),
    });

    expect(reset.statusCode).toBe(200);
    const next = reset.json().password as string;
    expect(next).not.toBe(t.owner.password);

    expect(await passwordAccepted(ctx, t.owner.email, next)).toBe(true);
    expect(await passwordAccepted(ctx, t.owner.email, t.owner.password)).toBe(false);
  });

  it("disabling cuts access off, and enabling restores it", async () => {
    const ctx = await makeApi();
    const t = await newTenant(ctx, "Disable", "owner@disable.test");
    const userId = await userIdOf(ctx, t.tenant.id);

    const off = await ctx.app.inject({
      method: "POST",
      url: `/admin/api/tenants/${t.tenant.id}/users/${userId}/disable`,
      headers: adminAuth(),
    });
    expect(off.statusCode).toBe(200);
    expect(await passwordAccepted(ctx, t.owner.email, t.owner.password)).toBe(false);

    const on = await ctx.app.inject({
      method: "POST",
      url: `/admin/api/tenants/${t.tenant.id}/users/${userId}/enable`,
      headers: adminAuth(),
    });
    expect(on.statusCode).toBe(200);
    expect(await passwordAccepted(ctx, t.owner.email, t.owner.password)).toBe(true);
  });

  it("revokes live sessions without changing the password", async () => {
    const ctx = await makeApi();
    const t = await newTenant(ctx, "Sessions", "owner@sessions.test");
    const userId = await userIdOf(ctx, t.tenant.id);

    const res = await ctx.app.inject({
      method: "POST",
      url: `/admin/api/tenants/${t.tenant.id}/users/${userId}/revoke-sessions`,
      headers: adminAuth(),
    });

    expect(res.statusCode).toBe(200);
    expect(typeof res.json().revoked).toBe("number");
    expect(await passwordAccepted(ctx, t.owner.email, t.owner.password)).toBe(true);
  });
});

describe("tenant user routes cannot be aimed at someone else's account", () => {
  it("refuses a user id that belongs to a different tenant", async () => {
    const ctx = await makeApi();
    const a = await newTenant(ctx, "Alpha", "owner@alpha.test");
    const b = await newTenant(ctx, "Bravo", "owner@bravo.test");
    const bUser = await userIdOf(ctx, b.tenant.id);

    // Bravo's user, reached through Alpha's tenant id.
    const res = await ctx.app.inject({
      method: "POST",
      url: `/admin/api/tenants/${a.tenant.id}/users/${bUser}/reset-password`,
      headers: adminAuth(),
    });

    expect(res.statusCode).toBe(404);
    expect(await passwordAccepted(ctx, b.owner.email, b.owner.password)).toBe(true);
  });

  it("refuses an id that is not a principal at all", async () => {
    const ctx = await makeApi();
    const t = await newTenant(ctx, "Charlie", "owner@charlie.test");

    const res = await ctx.app.inject({
      method: "POST",
      url: `/admin/api/tenants/${t.tenant.id}/users/00000000-0000-0000-0000-000000000000/disable`,
      headers: adminAuth(),
    });
    expect(res.statusCode).toBe(404);
  });

  // The OPERATOR case -- an operator resetting an owner's password through these
  // routes -- is covered in `tenant-user-guard.test.ts`. It cannot be reached
  // here: an operator has to exist for the test to aim at one, and the moment one
  // does the shared admin token this harness uses stops working. Asserting it
  // through HTTP passed without executing the assertion at all.

  it("keeps the new password out of the append-only audit trail", async () => {
    const ctx = await makeApi();
    const t = await newTenant(ctx, "Audited", "owner@audited-reset.test");
    const userId = await userIdOf(ctx, t.tenant.id);

    const reset = await ctx.app.inject({
      method: "POST",
      url: `/admin/api/tenants/${t.tenant.id}/users/${userId}/reset-password`,
      headers: adminAuth(),
    });
    const password = reset.json().password as string;

    const audit = await ctx.app.inject({
      method: "GET",
      url: "/admin/api/audit?limit=50",
      headers: adminAuth(),
    });

    expect(JSON.stringify(audit.json())).not.toContain(password);
    expect(JSON.stringify(audit.json())).toContain("tenant_user.reset_password");
  });
});
