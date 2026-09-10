import { InvalidRoleError } from "@/common";
import type { PrincipalKind } from "@/types";

export const OPERATOR_ROLES = ["owner", "operator", "viewer"] as const;
export const TENANT_ROLES = ["admin", "member", "viewer"] as const;

export type OperatorRole = (typeof OPERATOR_ROLES)[number];
export type TenantRole = (typeof TENANT_ROLES)[number];
export type Role = OperatorRole | TenantRole;

export const PERMISSIONS = [
  "admin.read", // see the control plane at all
  "admin.tenants.manage", // create tenants, issue and revoke their keys
  "admin.operators.manage", // create and disable staff accounts
  "admin.killswitch", // halt and release all payouts
  "admin.treasury", // sweep fees on chain
  "tenant.read", // see this tenant's data
  "tenant.move_funds", // create accounts, addresses, allow-list entries, payouts
  "tenant.approve", // sign off a held payout
  "tenant.users.manage", // invite and remove this tenant's people
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const OPERATOR_PERMISSIONS: Record<OperatorRole, readonly Permission[]> = {
  owner: [
    "admin.read",
    "admin.tenants.manage",
    "admin.operators.manage",
    "admin.killswitch",
    "admin.treasury",
  ],

  operator: ["admin.read", "admin.tenants.manage", "admin.killswitch"],
  viewer: ["admin.read"],
};

const TENANT_PERMISSIONS: Record<TenantRole, readonly Permission[]> = {
  admin: ["tenant.read", "tenant.move_funds", "tenant.approve", "tenant.users.manage"],

  member: ["tenant.read", "tenant.move_funds"],
  viewer: ["tenant.read"],
};

const TOTP_REQUIRED: ReadonlySet<Role> = new Set<Role>([
  "owner",
  "operator", // kill switch + key issuance
  "admin", // tenant: payouts, approvals, user management
  "member", // tenant: can create payouts
]);

export const requiresTotp = (role: Role): boolean => TOTP_REQUIRED.has(role);

export function permissionsFor(kind: PrincipalKind, role: string): readonly Permission[] {
  if (kind === "operator") return OPERATOR_PERMISSIONS[role as OperatorRole] ?? [];
  return TENANT_PERMISSIONS[role as TenantRole] ?? [];
}

export function parseRole(kind: PrincipalKind, role: unknown): Role {
  const valid: readonly string[] = kind === "operator" ? OPERATOR_ROLES : TENANT_ROLES;
  if (typeof role !== "string" || !valid.includes(role)) {
    throw new InvalidRoleError(
      `Unknown ${kind} role ${JSON.stringify(role)}. Valid roles are ${valid.join(", ")}.`,
      { context: { valid: valid.join(",") }, exposable: true },
    );
  }
  return role as Role;
}

export function scopesForTenantRole(role: string): readonly ("read" | "move-funds" | "approve")[] {
  const perms = TENANT_PERMISSIONS[role as TenantRole] ?? [];
  const scopes: ("read" | "move-funds" | "approve")[] = [];
  if (perms.includes("tenant.read")) scopes.push("read");
  if (perms.includes("tenant.move_funds")) scopes.push("move-funds");
  if (perms.includes("tenant.approve")) scopes.push("approve");
  return scopes;
}
