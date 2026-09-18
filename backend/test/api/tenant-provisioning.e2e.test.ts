import { describe, expect, it } from "vitest";
import { adminAuth, makeApi } from "./harness.js";

/**
 * Provisioning a tenant has to produce a way for a PERSON to sign in, not only a
 * machine credential.
 *
 * The consoles authenticate humans against `principal` (ADR 0018); `/v1` still
 * takes a `cxk_…` API key. A tenant created with only the key is reachable by
 * API and by nobody at the portal, which is the state every tenant was left in
 * before this.
 */
describe("creating a tenant provisions both credentials", () => {
  it("returns an API key and a first sign-in", async () => {
    const ctx = await makeApi();

    const res = await ctx.app.inject({
      method: "POST",
      url: "/admin/api/tenants",
      headers: adminAuth(),
      payload: { name: "Acme", ownerEmail: "owner@acme.test" },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();

    expect(body.apiKey).toMatch(/^cxk_/);
    expect(body.owner).toMatchObject({ email: "owner@acme.test", role: "admin" });
    expect(typeof body.owner.password).toBe("string");
    expect(body.owner.password.length).toBeGreaterThan(16);
  });

  it("makes that sign-in usable, and forces the handover password to be replaced", async () => {
    const ctx = await makeApi();

    const created = await ctx.app.inject({
      method: "POST",
      url: "/admin/api/tenants",
      headers: adminAuth(),
      payload: { name: "Beta", ownerEmail: "owner@beta.test" },
    });
    const { owner } = created.json();

    const login = await ctx.app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: "owner@beta.test", password: owner.password, kind: "tenant_user" },
    });

    expect(login.statusCode).toBe(200);
    // `admin` requires a second factor, so the password alone must not yield a
    // session -- it yields an MFA challenge.
    expect(login.json().status).toBe("mfa_enrolment_required");
  });

  it("scopes the new user to its own tenant", async () => {
    const ctx = await makeApi();

    const created = await ctx.app.inject({
      method: "POST",
      url: "/admin/api/tenants",
      headers: adminAuth(),
      payload: { name: "Gamma", ownerEmail: "owner@gamma.test" },
    });
    const tenantId = created.json().tenant.id;

    const users = await ctx.app.inject({
      method: "GET",
      url: `/admin/api/tenants/${tenantId}/users`,
      headers: adminAuth(),
    });

    expect(users.statusCode).toBe(200);
    expect(users.json().users).toHaveLength(1);
    expect(users.json().users[0]).toMatchObject({
      email: "owner@gamma.test",
      role: "admin",
      tenantId,
      mustChangePassword: true,
    });
  });

  it("still provisions a machine-only tenant when no owner is named", async () => {
    const ctx = await makeApi();

    const res = await ctx.app.inject({
      method: "POST",
      url: "/admin/api/tenants",
      headers: adminAuth(),
      payload: { name: "Headless" },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().apiKey).toMatch(/^cxk_/);
    expect(res.json().owner).toBeNull();
  });

  it("lets the same person own accounts at two different tenants", async () => {
    const ctx = await makeApi();

    // `principal_tenant_email` is unique on (tenant_id, lower(email)), not on
    // email alone: ADR 0018 is explicit that two tenants may each employ the
    // same person. Only a second account at the SAME tenant is a clash.
    for (const name of ["First", "Second"]) {
      const res = await ctx.app.inject({
        method: "POST",
        url: "/admin/api/tenants",
        headers: adminAuth(),
        payload: { name, ownerEmail: "shared@acme.test" },
      });
      expect(res.statusCode, `${name} should provision`).toBe(201);
    }
  });

  it("creates no tenant at all when the owner cannot be created", async () => {
    const ctx = await makeApi();

    // A malformed address fails inside `createPrincipal`, after the tenant row
    // and its API key have already been inserted. Without one transaction around
    // the pair, the engine would be left holding a live credential for a tenant
    // nobody can sign into -- the exact state this change exists to prevent.
    const res = await ctx.app.inject({
      method: "POST",
      url: "/admin/api/tenants",
      headers: adminAuth(),
      payload: { name: "Rolled Back", ownerEmail: "not-an-email" },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);

    const tenants = await ctx.app.inject({
      method: "GET",
      url: "/admin/api/tenants",
      headers: adminAuth(),
    });
    const names = tenants.json().map((t: { name: string }) => t.name);
    expect(names).not.toContain("Rolled Back");
  });

  it("keeps the generated password out of the append-only audit trail", async () => {
    const ctx = await makeApi();

    const created = await ctx.app.inject({
      method: "POST",
      url: "/admin/api/tenants",
      headers: adminAuth(),
      payload: { name: "Audited", ownerEmail: "owner@audited.test" },
    });
    const { password } = created.json().owner;

    const audit = await ctx.app.inject({
      method: "GET",
      url: "/admin/api/audit?limit=50",
      headers: adminAuth(),
    });

    // admin_audit has no UPDATE or DELETE grant, so anything written here is
    // permanent -- a credential in it could never be redacted afterwards.
    expect(JSON.stringify(audit.json())).not.toContain(password);
    expect(JSON.stringify(audit.json())).toContain("owner@audited.test");
  });
});
