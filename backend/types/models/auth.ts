export interface Session {
  id: string;
  principalId: string;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
  idleExpiresAt: Date;
  ip: string | null;
  userAgent: string | null;
}

export interface SessionConfig {
  absoluteMs: number;

  idleMs: number;

  maxFailedLogins: number;
  lockoutMs: number;
}

export type PrincipalKind = "operator" | "tenant_user";

export interface TotpResult {
  ok: boolean;

  step?: number;
}
