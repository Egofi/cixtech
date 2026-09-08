import type { AuthStore, Principal, Session } from "@/auth";
import { tokensMatch } from "@/auth";
import { type Permission, permissionsFor } from "@/auth";
import { AppError } from "@/errors";
import type { FastifyReply, FastifyRequest } from "fastify";

export class NotAuthenticatedError extends AppError {
  readonly code = "NOT_AUTHENTICATED";
}
export class ForbiddenError extends AppError {
  readonly code = "FORBIDDEN";
}
export class CsrfError extends AppError {
  readonly code = "CSRF_FAILED";
}
export class PasswordChangeRequiredError extends AppError {
  readonly code = "PASSWORD_CHANGE_REQUIRED";
}

export const SESSION_COOKIE = "cx_session";
export const CSRF_HEADER = "x-csrf-token";

export interface CookieOptions {
  /**
   * Cross-site cookie delivery.
   *
   * The consoles are a different origin from the API, so the session cookie is
   * a cross-site cookie and needs `SameSite=None; Secure` to be sent at all.
   * That is precisely the configuration SameSite exists to restrict, which is
   * why the CSRF check below is not optional here — it is the control doing the
   * work SameSite would otherwise do.
   *
   * Set false only when the API and the consoles share an origin behind one
   * proxy, where `SameSite=Lax` is both sufficient and stronger.
   */
  crossSite: boolean;
  /** Send `Secure`. Off only for plain-HTTP local development. */
  secure: boolean;
  /** Scope the cookie to a parent domain, e.g. `.cixtech.com`. */
  domain?: string | undefined;
}

export const DEFAULT_COOKIE_OPTIONS: CookieOptions = { crossSite: true, secure: true };

function serializeCookie(
  name: string,
  value: string,
  opts: CookieOptions & { maxAgeSeconds?: number },
): string {
  const parts = [`${name}=${value}`, "Path=/", "HttpOnly"];
  if (opts.maxAgeSeconds !== undefined) parts.push(`Max-Age=${opts.maxAgeSeconds}`);
  if (opts.domain) parts.push(`Domain=${opts.domain}`);
  // A cross-site cookie MUST be Secure — browsers reject SameSite=None without
  // it — so the two travel together rather than being configured independently.
  if (opts.crossSite) parts.push("SameSite=None", "Secure");
  else {
    parts.push("SameSite=Lax");
    if (opts.secure) parts.push("Secure");
  }
  return parts.join("; ");
}

export function setSessionCookie(
  reply: FastifyReply,
  token: string,
  expiresAt: Date,
  opts: CookieOptions,
): void {
  const maxAgeSeconds = Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
  reply.header("set-cookie", serializeCookie(SESSION_COOKIE, token, { ...opts, maxAgeSeconds }));
}

export function clearSessionCookie(reply: FastifyReply, opts: CookieOptions): void {
  reply.header("set-cookie", serializeCookie(SESSION_COOKIE, "", { ...opts, maxAgeSeconds: 0 }));
}

/** Read one cookie without pulling in a parser plugin for a single value. */
export function readCookie(req: FastifyRequest, name: string): string | undefined {
  const header = req.headers.cookie;
  if (typeof header !== "string") return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

export interface AuthContext {
  principal: Principal;
  session: Session;
  permissions: readonly Permission[];
  /**
   * The CSRF value this session expects, for a page that has just reloaded and
   * lost the one it was given at sign-in. Only ever returned to the session's
   * own origin, which CORS enforces.
   */
  csrfToken: string;
}

/** Methods that cannot change state, and so need no CSRF token. */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Resolve the session on a request, enforcing CSRF on anything that mutates.
 *
 * Double-submit: the token is in an httpOnly cookie the page cannot read, and
 * its match must be echoed in a header. A cross-site attacker can cause the
 * browser to SEND the cookie, but the same-origin policy stops them reading the
 * value to put in the header — so a forged request arrives without it.
 *
 * Comparing hashes rather than the raw values keeps the check constant-time
 * against the stored digest, and means the CSRF secret is no more recoverable
 * from a database dump than the session token is.
 */
export async function resolveAuth(
  store: AuthStore,
  req: FastifyRequest,
): Promise<AuthContext | null> {
  const token = readCookie(req, SESSION_COOKIE);
  if (!token) return null;

  const resolved = await store.resolveSession(token);
  if (!resolved) return null;

  if (!SAFE_METHODS.has(req.method)) {
    const provided = req.headers[CSRF_HEADER];
    const value = typeof provided === "string" ? provided : "";
    if (!value || !tokensMatch(value, resolved.csrfToken)) {
      throw new CsrfError(
        "Missing or invalid CSRF token. Send the value from GET /auth/session in the x-csrf-token header.",
        { exposable: true },
      );
    }
  }

  return {
    principal: resolved.principal,
    session: resolved.session,
    permissions: permissionsFor(resolved.principal.kind, resolved.principal.role),
    csrfToken: resolved.csrfToken,
  };
}

/** Assert a permission, or fail with a message that says which one was missing. */
export function requirePermission(ctx: AuthContext | null, permission: Permission): AuthContext {
  if (!ctx) throw new NotAuthenticatedError("Sign in to continue", { exposable: true });

  // A forced password change must be completed before anything else — otherwise
  // an invited account with a temporary password keeps working indefinitely.
  if (ctx.principal.mustChangePassword) {
    throw new PasswordChangeRequiredError("Set a new password before continuing", {
      exposable: true,
    });
  }
  if (!ctx.permissions.includes(permission)) {
    throw new ForbiddenError(`Your role (${ctx.principal.role}) cannot ${permission}`, {
      context: { required: permission, role: ctx.principal.role },
      exposable: true,
    });
  }
  return ctx;
}
