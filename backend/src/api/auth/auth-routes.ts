import { permissionsFor, requiresTotp, totpEnrolmentUri } from "@/auth";
import {
  AuthError,
  MfaEnrolmentRequiredError,
  MfaRequiredError,
  NotAuthenticatedError,
  PasswordChangeRequiredError,
} from "@/common";
import { AUTH_ROUTES } from "@/common/routes";
import type { AuthStore, Principal } from "@/stores";
import type { CookieOptions, PrincipalKind } from "@/types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  type AuthContext,
  clearSessionCookie,
  resolveAuth,
  setSessionCookie,
} from "./session-middleware.js";

export interface AuthRouteOptions {
  store: AuthStore;
  cookie: CookieOptions;

  tenantResolver?: (email: string, hint?: string) => Promise<string | null>;
}

const clientMeta = (req: FastifyRequest) => ({
  ip: req.ip,
  userAgent: typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : null,
});

const publicPrincipal = (p: Principal) => ({
  id: p.id,
  email: p.email,
  kind: p.kind,
  role: p.role,
  tenantId: p.tenantId,
  totpConfirmed: p.totpConfirmed,
  mustChangePassword: p.mustChangePassword,
  permissions: permissionsFor(p.kind, p.role),
  totpRequired: requiresTotp(p.role),
});

export function registerAuth(app: FastifyInstance, opts: AuthRouteOptions): void {
  const { store, cookie } = opts;

  const challenges = new Map<string, { principalId: string; expires: number }>();
  const CHALLENGE_MS = 2 * 60_000;

  const sweepChallenges = () => {
    const now = Date.now();
    for (const [k, v] of challenges) if (v.expires < now) challenges.delete(k);
  };

  const hidden = { schema: { hide: true } as const };

  async function issueSession(reply: FastifyReply, req: FastifyRequest, principal: Principal) {
    const { token, csrfToken, session } = await store.createSession(principal.id, clientMeta(req));
    setSessionCookie(reply, token, session.expiresAt, cookie);
    await store.recordAttempt({
      email: principal.email,
      principalId: principal.id,
      kind: principal.kind,
      outcome: "session_created",
      ...clientMeta(req),
    });
    return {
      principal: publicPrincipal(principal),

      csrfToken,
      expiresAt: session.expiresAt.toISOString(),
    };
  }

  app.post(AUTH_ROUTES.LOGIN, hidden, async (req, reply) => {
    const body = (req.body ?? {}) as {
      email?: string;
      password?: string;
      kind?: PrincipalKind;
      tenantId?: string;
    };
    const kind: PrincipalKind = body.kind === "tenant_user" ? "tenant_user" : "operator";

    if (!body.email || !body.password) {
      return reply
        .status(400)
        .send({ error: { code: "BAD_REQUEST", message: "email and password are required" } });
    }

    let tenantId: string | null = null;
    if (kind === "tenant_user") {
      tenantId = opts.tenantResolver
        ? await opts.tenantResolver(body.email, body.tenantId)
        : (body.tenantId ?? null);
    }

    try {
      const result = await store.verifyCredentials({
        kind,
        email: body.email,
        password: body.password,
        tenantId,
      });

      if (result.outcome === "ok") {
        return reply.send(await issueSession(reply, req, result.principal));
      }

      sweepChallenges();
      const challenge = `chal_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
      challenges.set(challenge, {
        principalId: result.principal.id,
        expires: Date.now() + CHALLENGE_MS,
      });

      if (result.outcome === "mfa_enrolment_required") {
        const secret = await store.beginTotpEnrolment(result.principal.id);
        return reply.status(200).send({
          status: "mfa_enrolment_required",
          challenge,
          totp: {
            secret,
            uri: totpEnrolmentUri(secret, result.principal.email),
          },
        });
      }
      return reply.status(200).send({ status: "mfa_required", challenge });
    } catch (err) {
      await store.recordAttempt({
        email: body.email,
        kind,
        outcome: "failed",
        detail: err instanceof Error ? err.message : String(err),
        ...clientMeta(req),
      });
      throw err;
    }
  });

  app.post(AUTH_ROUTES.MFA, hidden, async (req, reply) => {
    const body = (req.body ?? {}) as { challenge?: string; code?: string; enrol?: boolean };
    sweepChallenges();
    const pending = body.challenge ? challenges.get(body.challenge) : undefined;
    if (!pending) {
      throw new AuthError("That sign-in attempt has expired. Start again.", { exposable: true });
    }
    if (!body.code) {
      return reply
        .status(400)
        .send({ error: { code: "BAD_REQUEST", message: "code is required" } });
    }

    const principal = await store.loadById(pending.principalId);
    if (!principal) throw new AuthError("Account no longer exists", { exposable: true });

    if (body.enrol) {
      const recoveryCodes = await store.confirmTotp(principal.id, body.code);
      challenges.delete(body.challenge as string);
      const fresh = (await store.loadById(principal.id)) ?? principal;
      const session = await issueSession(reply, req, fresh);
      return reply.send({ ...session, recoveryCodes });
    }

    const ok = await store.verifySecondFactor(principal.id, body.code);
    if (!ok) {
      await store.recordAttempt({
        email: principal.email,
        principalId: principal.id,
        kind: principal.kind,
        outcome: "mfa_failed",
        ...clientMeta(req),
      });
      throw new AuthError("That code is not correct", { exposable: true });
    }
    challenges.delete(body.challenge as string);
    return reply.send(await issueSession(reply, req, principal));
  });

  app.get(AUTH_ROUTES.SESSION, hidden, async (req, reply) => {
    const ctx = await resolveAuth(store, req);
    if (!ctx)
      return reply
        .status(401)
        .send({ error: { code: "NOT_AUTHENTICATED", message: "No session" } });

    return {
      principal: publicPrincipal(ctx.principal),
      csrfToken: ctx.csrfToken,
      session: {
        id: ctx.session.id,
        expiresAt: ctx.session.expiresAt.toISOString(),
        idleExpiresAt: ctx.session.idleExpiresAt.toISOString(),
      },
    };
  });

  app.post(AUTH_ROUTES.LOGOUT, hidden, async (req, reply) => {
    const ctx = await resolveAuth(store, req);
    if (ctx) {
      await store.revokeSession(ctx.session.id);
      await store.recordAttempt({
        email: ctx.principal.email,
        principalId: ctx.principal.id,
        kind: ctx.principal.kind,
        outcome: "signed_out",
        ...clientMeta(req),
      });
    }

    clearSessionCookie(reply, cookie);
    return reply.send({ ok: true });
  });

  const mustBeSignedIn = async (req: FastifyRequest): Promise<AuthContext> => {
    const ctx = await resolveAuth(store, req);
    if (!ctx) throw new NotAuthenticatedError("Sign in to continue", { exposable: true });
    return ctx;
  };

  app.get(AUTH_ROUTES.SESSIONS, hidden, async (req) => {
    const ctx = await mustBeSignedIn(req);
    const sessions = await store.listSessions(ctx.principal.id);
    return {
      sessions: sessions.map((s) => ({
        id: s.id,
        current: s.id === ctx.session.id,
        createdAt: s.createdAt.toISOString(),
        lastSeenAt: s.lastSeenAt.toISOString(),
        expiresAt: s.expiresAt.toISOString(),
        ip: s.ip,
        userAgent: s.userAgent,
      })),
    };
  });

  app.delete(AUTH_ROUTES.SESSIONS_BY_ID, hidden, async (req, reply) => {
    const ctx = await mustBeSignedIn(req);
    const { id } = req.params as { id: string };

    const mine = await store.listSessions(ctx.principal.id);
    if (!mine.some((s) => s.id === id)) {
      return reply.status(404).send({ error: { code: "NOT_FOUND", message: "No such session" } });
    }
    await store.revokeSession(id, "revoked by user");
    if (id === ctx.session.id) clearSessionCookie(reply, cookie);
    return { ok: true };
  });

  app.post(AUTH_ROUTES.LOGOUT_ALL, hidden, async (req, reply) => {
    const ctx = await mustBeSignedIn(req);
    const revoked = await store.revokeAllSessions(ctx.principal.id);
    clearSessionCookie(reply, cookie);
    return reply.send({ ok: true, revoked });
  });

  app.post(AUTH_ROUTES.PASSWORD, hidden, async (req, reply) => {
    const ctx = await resolveAuth(store, req);
    if (!ctx) throw new NotAuthenticatedError("Sign in to continue", { exposable: true });
    const body = (req.body ?? {}) as { currentPassword?: string; newPassword?: string };
    if (!body.currentPassword || !body.newPassword) {
      return reply.status(400).send({
        error: { code: "BAD_REQUEST", message: "currentPassword and newPassword are required" },
      });
    }
    if (body.newPassword.length < 12) {
      return reply.status(400).send({
        error: { code: "BAD_REQUEST", message: "New password must be at least 12 characters" },
      });
    }

    await store.verifyCredentials({
      kind: ctx.principal.kind,
      email: ctx.principal.email,
      password: body.currentPassword,
      tenantId: ctx.principal.tenantId,
    });

    await store.setPassword(ctx.principal.id, body.newPassword, false);

    await store.revokeAllSessions(ctx.principal.id, "password changed");
    const fresh = (await store.loadById(ctx.principal.id)) as Principal;
    return reply.send(await issueSession(reply, req, fresh));
  });

  app.post(AUTH_ROUTES.TOTP_BEGIN, hidden, async (req) => {
    const ctx = await mustBeSignedIn(req);
    const secret = await store.beginTotpEnrolment(ctx.principal.id);
    return { secret, uri: totpEnrolmentUri(secret, ctx.principal.email) };
  });

  app.post(AUTH_ROUTES.TOTP_CONFIRM, hidden, async (req, reply) => {
    const ctx = await mustBeSignedIn(req);
    const { code } = (req.body ?? {}) as { code?: string };
    if (!code) {
      return reply
        .status(400)
        .send({ error: { code: "BAD_REQUEST", message: "code is required" } });
    }
    const recoveryCodes = await store.confirmTotp(ctx.principal.id, code);
    return { ok: true, recoveryCodes };
  });

  void MfaRequiredError;
  void MfaEnrolmentRequiredError;
  void PasswordChangeRequiredError;
}
