import { assertTenantUserOf, isTenantUserOf } from "@/api/admin/tenant-user-guard.js";
import type { Principal } from "@/stores";
import { describe, expect, it } from "vitest";

const principal = (over: Partial<Principal> = {}): Principal => ({
  id: "p1",
  kind: "tenant_user",
  tenantId: "t1",
  email: "someone@example.test",
  role: "admin",
  status: "active",
  mustChangePassword: false,
  totpConfirmed: true,
  ...over,
});

/**
 * The tenant-user lifecycle routes are gated on `admin.tenants.manage`, which the
 * `operator` role holds. `admin.operators.manage` — the permission that guards
 * staff accounts — is `owner` only. So the route's own permission does NOT imply
 * the target is safe to touch, and this is the check that makes it so.
 *
 * Tested here rather than over HTTP because reaching the operator case end to end
 * needs an operator to exist, which disables the shared admin token the API
 * harness signs in with. An e2e test of it passes without executing anything.
 */
describe("only a user of this tenant is a valid target", () => {
  it("accepts a tenant_user of the named tenant", () => {
    expect(isTenantUserOf(principal(), "t1")).toBe(true);
    expect(assertTenantUserOf(principal(), "t1").id).toBe("p1");
  });

  it("refuses an OPERATOR, whatever tenant id is supplied", () => {
    // The escalation this exists to stop: an operator resetting an owner's
    // password through a route that looks like tenant administration.
    const owner = principal({ kind: "operator", tenantId: null, role: "owner" });
    expect(isTenantUserOf(owner, "t1")).toBe(false);
    expect(isTenantUserOf(owner, "")).toBe(false);
    expect(() => assertTenantUserOf(owner, "t1")).toThrow(/No such user/);
  });

  it("refuses a tenant_user belonging to a different tenant", () => {
    expect(isTenantUserOf(principal({ tenantId: "t2" }), "t1")).toBe(false);
    expect(() => assertTenantUserOf(principal({ tenantId: "t2" }), "t1")).toThrow();
  });

  it("refuses a principal that does not exist", () => {
    expect(isTenantUserOf(null, "t1")).toBe(false);
    expect(() => assertTenantUserOf(null, "t1")).toThrow();
  });

  it("refuses rather than matching a null tenant against a null tenant", () => {
    // An operator has `tenantId: null`. If the comparison were loose, asking for
    // tenant "" or undefined could match one.
    const operator = principal({ kind: "operator", tenantId: null });
    expect(isTenantUserOf(operator, null as unknown as string)).toBe(false);
  });

  it("answers 404, so it cannot be used to probe for ids on other tenants", () => {
    try {
      assertTenantUserOf(principal({ tenantId: "t2" }), "t1");
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as { code: string }).code).toBe("PRINCIPAL_NOT_FOUND");
      expect((err as { status: number }).status).toBe(404);
    }
  });
});
