import { PrincipalNotFoundError } from "@/common";
import type { Principal } from "@/stores";

/**
 * Whether a principal is a user of *this* tenant, and therefore a legitimate
 * target for the tenant-user lifecycle routes.
 *
 * Those routes are gated on `admin.tenants.manage`, which the `operator` role
 * holds — unlike `admin.operators.manage`, which only `owner` holds. So without
 * this check, `POST /admin/api/tenants/<anything>/users/<an-owner-id>/reset-password`
 * would let an operator set an owner's password and take the account: a straight
 * privilege escalation through a route that reads as tenant administration.
 *
 * Both halves matter. The `kind` check stops an operator being targeted at all;
 * the `tenantId` check stops one tenant's administrator reaching another's
 * people. Neither is implied by the route's own permission.
 *
 * Pure and exported so the rule can be tested directly. Reaching it over HTTP
 * requires an operator to exist, which disables the shared admin token the test
 * harness authenticates with — so an end-to-end test of the operator case
 * quietly tests nothing.
 */
export function isTenantUserOf(principal: Principal | null, tenantId: string): boolean {
  if (!principal) return false;
  if (principal.kind !== "tenant_user") return false;
  return principal.tenantId === tenantId;
}

/**
 * The same rule, as the refusal the routes raise.
 *
 * A principal that exists but belongs elsewhere answers 404 rather than 403, so
 * the response cannot be used to confirm that an id exists on another tenant.
 */
export function assertTenantUserOf(principal: Principal | null, tenantId: string): Principal {
  if (!isTenantUserOf(principal, tenantId)) {
    throw new PrincipalNotFoundError("No such user on this tenant", { exposable: true });
  }
  return principal as Principal;
}
