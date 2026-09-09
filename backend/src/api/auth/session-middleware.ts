import { permissionsFor, tokensMatch } from "@/auth";
import type { Permission } from "@/auth";
import {
  CsrfError,
  ForbiddenError,
  NotAuthenticatedError,
  PasswordChangeRequiredError,
} from "@/common";
import type { AuthStore, Principal } from "@/stores";
import type { CookieOptions, Session } from "@/types";
import type { FastifyReply, FastifyRequest } from "fastify";

export const SESSION_COOKIE = "cx_session";
export const CSRF_HEADER = "x-csrf-token";

export const DEFAULT_COOKIE_OPTIONS: CookieOptions = { crossSite: true, secure: true };

function serializeCookie(
  name: string,
  value: string,
  opts: CookieOptions & { maxAgeSeconds?: number },
): string {
  const parts = [`${name}=${value}`, "Path=/", "HttpOnly"];
  if (opts.maxAgeSeconds !== undefined) parts.push(`Max-Age=${opts.maxAgeSeconds}`);
  if (opts.domain) parts.push(`Domain=${opts.domain}`);

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

  csrfToken: string;
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

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

export function requirePermission(ctx: AuthContext | null, permission: Permission): AuthContext {
  if (!ctx) throw new NotAuthenticatedError("Sign in to continue", { exposable: true });

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
