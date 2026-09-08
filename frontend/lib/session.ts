"use client";

import { apiUrl } from "./config";

/**
 * The browser half of the session system.
 *
 * The session itself is an httpOnly cookie this code cannot read — that is the
 * point, and it is what makes an XSS unable to exfiltrate it. What the page
 * holds is the CSRF token, in memory only, echoed on every mutation.
 *
 * `credentials: "include"` on every call, because the API is a different origin
 * and the browser will not attach a cross-site cookie without it.
 */

export type Permission =
  | "admin.read"
  | "admin.tenants.manage"
  | "admin.operators.manage"
  | "admin.killswitch"
  | "admin.treasury"
  | "tenant.read"
  | "tenant.move_funds"
  | "tenant.approve"
  | "tenant.users.manage";

export interface Me {
  id: string;
  email: string;
  kind: "operator" | "tenant_user";
  role: string;
  tenantId: string | null;
  totpConfirmed: boolean;
  totpRequired: boolean;
  mustChangePassword: boolean;
  permissions: Permission[];
}

export class SessionError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

/**
 * The CSRF token, in a module variable rather than storage.
 *
 * Putting it in localStorage would hand it to the same XSS the httpOnly cookie
 * is protecting the session from, which would defeat the double-submit entirely.
 * A page reload loses it and re-reads it from `GET /auth/session`.
 */
let csrfToken: string | null = null;
export const setCsrfToken = (t: string | null) => {
  csrfToken = t;
};

const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);

export async function apiFetch<T>(
  path: string,
  opts: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<T> {
  const method = opts.method ?? "GET";
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (!SAFE.has(method) && csrfToken) headers["x-csrf-token"] = csrfToken;

  let res: Response;
  try {
    res = await fetch(apiUrl(path), {
      method,
      headers,
      credentials: "include",
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    });
  } catch {
    throw new SessionError(
      `Could not reach the API at ${apiUrl("")}. Check it is running and that this origin is in CIXTECH_CORS_ORIGINS.`,
      0,
      "NETWORK",
    );
  }

  const text = await res.text();
  const parsed: unknown = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const err = (parsed as { error?: { message?: string; code?: string } } | null)?.error;
    throw new SessionError(err?.message ?? `HTTP ${res.status}`, res.status, err?.code);
  }
  return parsed as T;
}

export interface LoginChallenge {
  status: "mfa_required" | "mfa_enrolment_required";
  challenge: string;
  totp?: { secret: string; uri: string };
}
export interface LoginSuccess {
  principal: Me;
  csrfToken: string;
  expiresAt: string;
  recoveryCodes?: string[];
}

export const isChallenge = (r: LoginSuccess | LoginChallenge): r is LoginChallenge => "status" in r;

export async function login(
  email: string,
  password: string,
  kind: "operator" | "tenant_user",
): Promise<LoginSuccess | LoginChallenge> {
  const res = await apiFetch<LoginSuccess | LoginChallenge>("/auth/login", {
    method: "POST",
    body: { email, password, kind },
  });
  if (!isChallenge(res)) setCsrfToken(res.csrfToken);
  return res;
}

export async function submitMfa(
  challenge: string,
  code: string,
  enrol = false,
): Promise<LoginSuccess> {
  const res = await apiFetch<LoginSuccess>("/auth/mfa", {
    method: "POST",
    body: { challenge, code, enrol },
  });
  setCsrfToken(res.csrfToken);
  return res;
}

/**
 * Re-establish the session after a page reload. Null when not signed in.
 *
 * The CSRF token lives in memory only, so a reload loses it — this is where it
 * comes back. The httpOnly cookie survived the reload on its own; only the
 * double-submit half needs recovering.
 */
export async function currentSession(): Promise<Me | null> {
  try {
    const res = await apiFetch<{ principal: Me; csrfToken: string }>("/auth/session");
    setCsrfToken(res.csrfToken);
    return res.principal;
  } catch {
    setCsrfToken(null);
    return null;
  }
}

export async function logout(): Promise<void> {
  try {
    await apiFetch("/auth/logout", { method: "POST" });
  } finally {
    setCsrfToken(null);
  }
}
