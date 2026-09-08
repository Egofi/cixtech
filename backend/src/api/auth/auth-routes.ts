import {
  AuthError,
  type AuthStore,
  MfaEnrolmentRequiredError,
  MfaRequiredError,
  type Principal,
} from "@/auth";
import { totpEnrolmentUri } from "@/auth";
import { type PrincipalKind, permissionsFor, requiresTotp } from "@/auth";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  type AuthContext,
  type CookieOptions,
  NotAuthenticatedError,
  PasswordChangeRequiredError,
  clearSessionCookie,
  resolveAuth,
  setSessionCookie,
} from "./session-middleware.js";

export interface AuthRouteOptions {
  store: AuthStore;
  cookie: CookieOptions;
  /** Resolves the tenant a portal login belongs to, from its email domain or an explicit id. */
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

/**
 * Sign-in, sign-out, and everything a person needs to manage their own account.
 *
 * Login is two calls, not one. `POST /auth/login` verifies the password and,
 * when the role requires a second factor, returns a short-lived challenge
 * instead of a session — so a correct password on its own never produces a
 * cookie. `POST /auth/mfa` completes it.
 *
 * The challenge is deliberately NOT a partial session: it is a signed-nothing
 * opaque id held in memory with a two-minute life, so an interrupted login
 * cannot be resumed later or from elsewhere.
 */
export function registerAuth(app: FastifyInstance, opts: AuthRouteOptions): void {
  const { store, cookie } = opts;

  /**
   * Pending second-factor challenges.
   *
   * In-process on purpose. They live for two minutes, are single-use, and are
   * worthless without the password that created them — persisting them would
   * add a table whose only job is to make an interrupted login survive a deploy.
   * A restart during login means signing in again, which is the correct
   * behaviour anyway.
   *
   * The trade to know: with several API replicas the MFA step must reach the
   * same one. Behind a load balancer, either enable sticky sessions for
   * /auth/mfa or move this to Redis.
   */
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
      // The page keeps this in memory and echoes it on every mutation. It is not
      // a secret from the user — it is a value an attacker's origin cannot read.
      csrfToken,
      expiresAt: session.expiresAt.toISOString(),
    };
  }

  // ── Sign in ────────────────────────────────────────────────────────────────
  app.post("/auth/login", hidden, async (req, reply) => {
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
        // The role demands a second factor and this person has none, so enrolment
        // is part of signing in rather than something they can postpone.
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

  // ── Second factor ──────────────────────────────────────────────────────────
  app.post("/auth/mfa", hidden, async (req, reply) => {
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

    // Enrolment path: the code proves the authenticator works before the factor
    // starts counting, and recovery codes are shown exactly once.
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

  // ── Current session ────────────────────────────────────────────────────────
  app.get("/auth/session", hidden, async (req, reply) => {
    const ctx = await resolveAuth(store, req);
    if (!ctx)
      return reply
        .status(401)
        .send({ error: { code: "NOT_AUTHENTICATED", message: "No session" } });
    // The CSRF token comes back here so a page reload can recover it — it lives
    // in memory only, so it does not survive one. Returning it is safe: CORS
    // stops another origin from reading this response, which is the whole basis
    // of the double-submit check.
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

  app.post("/auth/logout", hidden, async (req, reply) => {
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
    // Clear the cookie regardless: a request with an already-invalid session
    // should still leave the browser without one.
    clearSessionCookie(reply, cookie);
    return reply.send({ ok: true });
  });

  // ── Managing your own account ──────────────────────────────────────────────
  const mustBeSignedIn = async (req: FastifyRequest): Promise<AuthContext> => {
    const ctx = await resolveAuth(store, req);
    if (!ctx) throw new NotAuthenticatedError("Sign in to continue", { exposable: true });
    return ctx;
  };

  app.get("/auth/sessions", hidden, async (req) => {
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

  app.delete("/auth/sessions/:id", hidden, async (req, reply) => {
    const ctx = await mustBeSignedIn(req);
    const { id } = req.params as { id: string };
    // Only your own sessions: the id is a uuid, but authorising on ownership
    // rather than on unguessability is the difference between a control and a hope.
    const mine = await store.listSessions(ctx.principal.id);
    if (!mine.some((s) => s.id === id)) {
      return reply.status(404).send({ error: { code: "NOT_FOUND", message: "No such session" } });
    }
    await store.revokeSession(id, "revoked by user");
    if (id === ctx.session.id) clearSessionCookie(reply, cookie);
    return { ok: true };
  });

  app.post("/auth/logout-all", hidden, async (req, reply) => {
    const ctx = await mustBeSignedIn(req);
    const revoked = await store.revokeAllSessions(ctx.principal.id);
    clearSessionCookie(reply, cookie);
    return reply.send({ ok: true, revoked });
  });

  app.post("/auth/password", hidden, async (req, reply) => {
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
    // Re-verify the current password even though the session is valid: a session
    // left open on an unattended machine must not be enough to take the account.
    await store.verifyCredentials({
      kind: ctx.principal.kind,
      email: ctx.principal.email,
      password: body.currentPassword,
      tenantId: ctx.principal.tenantId,
    });

    await store.setPassword(ctx.principal.id, body.newPassword, false);
    // Every other session dies with the old password.
    await store.revokeAllSessions(ctx.principal.id, "password changed");
    const fresh = (await store.loadById(ctx.principal.id)) as Principal;
    return reply.send(await issueSession(reply, req, fresh));
  });

  // ── TOTP, for a role that does not require it ──────────────────────────────
  app.post("/auth/totp/begin", hidden, async (req) => {
    const ctx = await mustBeSignedIn(req);
    const secret = await store.beginTotpEnrolment(ctx.principal.id);
    return { secret, uri: totpEnrolmentUri(secret, ctx.principal.email) };
  });

  app.post("/auth/totp/confirm", hidden, async (req, reply) => {
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

  // Surface these so callers see a stable machine-readable code.
  void MfaRequiredError;
  void MfaEnrolmentRequiredError;
  void PasswordChangeRequiredError;
}
