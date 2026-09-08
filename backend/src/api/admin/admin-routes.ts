import { timingSafeEqual } from "node:crypto";
import type { AuthStore } from "@/auth";
import { chainEnvOrNull } from "@/chain-config";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { type AuthContext, requirePermission, resolveAuth } from "../auth/session-middleware.js";
import { UnauthorizedError, parseScopes } from "../stores.js";
import type { AdminService } from "./admin-service.js";

/**
 * The actor recorded when the legacy static token is used.
 *
 * Named rather than "super_admin" so the audit trail distinguishes "a person
 * called Sam did this" from "somebody holding the shared env token did this".
 * The second is what the whole session system exists to replace, and it should
 * be obvious in the log which one an action came from.
 */
const STATIC_TOKEN_ACTOR = "static-admin-token";

function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function bearer(req: FastifyRequest): string | undefined {
  const h = req.headers.authorization;
  if (typeof h !== "string" || !h.startsWith("Bearer ")) return undefined;
  return h.slice("Bearer ".length);
}

export interface AdminOptions {
  service: AdminService;
  /**
   * The legacy shared bearer token.
   *
   * Kept working, but only while NO operator account exists — it is the bootstrap
   * path, not a parallel way in. The moment the first operator is created it stops
   * being accepted, which is what forces the migration rather than leaving a
   * shared, non-expiring, unattributable credential live beside the sessions that
   * replaced it. `pnpm create-operator` is the other bootstrap route and always
   * works, so this cannot lock anyone out.
   */
  token: string | undefined;
  authStore: AuthStore;
}

/**
 * Mounts the admin control plane (ADR 0015): the JSON API at `/admin/api/*`,
 * guarded by a bearer token separate from tenant API keys. Every mutation is
 * written to the append-only admin audit trail — including failed attempts. Reads
 * span all tenants; controls are limited to operations that cannot move value
 * outside policy.
 *
 * The console ITSELF is no longer served here. It ships as a standalone static
 * bundle (`apps/web`) deployed independently, so the frontend can be released
 * without redeploying the custody engine — and so this process serves an API and
 * nothing else. Point the console at this API with CIXTECH_API_BASE, and allow
 * its origin with CIXTECH_CORS_ORIGINS.
 */
export function registerAdmin(app: FastifyInstance, opts: AdminOptions): void {
  const { service, token, authStore } = opts;

  /** Who is making this request — an operator session, or the bootstrap token. */
  const actors = new WeakMap<FastifyRequest, { actor: string; ctx: AuthContext | null }>();

  app.addHook("onRequest", async (req) => {
    if (!req.url.startsWith("/admin/api")) return;
    // /auth/* is how an operator signs in; it must not require being signed in.
    if (req.url.startsWith("/admin/api/auth")) return;

    const ctx = await resolveAuth(authStore, req);
    if (ctx) {
      if (ctx.principal.kind !== "operator") {
        throw new UnauthorizedError("This session is not an operator account");
      }
      // Every /admin/api route needs at least this; individual routes assert more.
      requirePermission(ctx, "admin.read");
      actors.set(req, { actor: ctx.principal.email, ctx });
      return;
    }

    // Bootstrap: the shared token works only until the first operator exists.
    if (!token) throw new UnauthorizedError("Admin plane is disabled");
    const provided = bearer(req);
    if (!provided || !tokenMatches(provided, token)) {
      throw new UnauthorizedError("Invalid admin token");
    }
    if ((await authStore.operatorCount()) > 0) {
      throw new UnauthorizedError(
        "The shared admin token is disabled because operator accounts exist. Sign in at /auth/login.",
      );
    }
    actors.set(req, { actor: STATIC_TOKEN_ACTOR, ctx: null });
  });

  /** Assert a permission for session-backed callers; the bootstrap token has all. */
  const need = (req: FastifyRequest, permission: Parameters<typeof requirePermission>[1]) => {
    const entry = actors.get(req);
    if (entry?.ctx) requirePermission(entry.ctx, permission);
  };

  const actorOf = (req: FastifyRequest): string => actors.get(req)?.actor ?? STATIC_TOKEN_ACTOR;

  // Wraps a mutating action so success AND failure are both audited.
  const mutate = async (
    req: FastifyRequest,
    action: string,
    target: string | undefined,
    params: Record<string, unknown> | undefined,
    fn: () => Promise<unknown>,
  ): Promise<unknown> => {
    try {
      const out = await fn();
      await service.recordAudit({
        actor: actorOf(req),
        action,
        target,
        params,
        result: "ok",
        ip: req.ip,
      });
      return out;
    } catch (err) {
      await service.recordAudit({
        actor: actorOf(req),
        action,
        target,
        params,
        result: "error",
        detail: err instanceof Error ? err.message : String(err),
        ip: req.ip,
      });
      throw err;
    }
  };

  const hidden = { schema: { hide: true } } as const;

  // ── Read API ────────────────────────────────────────────────────────────────
  const q = (req: FastifyRequest) => req.query as Record<string, string | undefined>;
  const lim = (req: FastifyRequest) => {
    const v = q(req)["limit"];
    return v ? Number(v) : undefined;
  };

  app.get("/admin/api/overview", hidden, () => service.overview());
  app.get("/admin/api/earnings", hidden, () => service.earningsAnalysis());
  app.post("/admin/api/earnings/sweep", hidden, async (req, reply) => {
    need(req, "admin.treasury");
    const asset = ((req.body ?? {}) as { asset?: string }).asset ?? "USDT";
    const res = await mutate(req, "earnings.sweep_fees", asset, { asset }, () =>
      service.sweepFees(asset),
    );
    return reply.status(200).send(res);
  });
  app.get("/admin/api/pool-addresses", hidden, (req) => {
    const { chain, tenant, merchant, state, funded, asset, offset } = q(req);
    return service.poolAddresses({
      ...(chain ? { chain } : {}),
      ...(tenant ? { tenant } : {}),
      ...(merchant ? { merchant } : {}),
      ...(state ? { state } : {}),
      ...(asset ? { asset } : {}),
      ...(funded === "true" ? { fundedOnly: true } : {}),
      ...(offset ? { offset: Number(offset) } : {}),
      ...(lim(req) !== undefined ? { limit: lim(req) } : {}),
    });
  });
  app.get("/admin/api/wallets/verify-onchain", hidden, (req, reply) => {
    const { chain, address, asset } = q(req);
    if (!chain || !address) {
      return reply
        .status(400)
        .send({ error: { code: "BAD_REQUEST", message: "chain and address required" } });
    }
    return service.verifyOnchainWallet(chain, address, asset);
  });
  // Symbol → decimals, so the console can turn base units into money. Its own
  // route rather than a field on the overview: every view needs it, and none of
  // them should have to pull the whole dashboard to get it.
  app.get("/admin/api/assets", hidden, () => ({ assets: service.assets(), env: chainEnvOrNull() }));
  app.get("/admin/api/tenants", hidden, () => service.listTenants());
  app.get("/admin/api/tenants/:id", hidden, async (req, reply) => {
    const { id } = req.params as { id: string };
    const t = await service.getTenant(id);
    if (!t) return reply.status(404).send({ error: { code: "NOT_FOUND", message: "tenant" } });
    return t;
  });
  app.get("/admin/api/ledger/accounts", hidden, () => service.ledgerAccounts());
  app.get("/admin/api/ledger/entries", hidden, (req) => {
    const { account, kind } = q(req);
    return service.entries({
      ...(account ? { account } : {}),
      ...(kind ? { kindPrefix: kind } : {}),
      ...(lim(req) !== undefined ? { limit: lim(req) } : {}),
    });
  });
  app.get("/admin/api/deposits", hidden, (req) => service.listDeposits(lim(req)));
  app.get("/admin/api/payouts", hidden, (req) => service.listPayouts(lim(req)));
  app.get("/admin/api/webhooks", hidden, (req) => {
    const status = q(req)["status"];
    return service.listWebhooks({
      ...(status ? { status } : {}),
      ...(lim(req) !== undefined ? { limit: lim(req) } : {}),
    });
  });
  app.get("/admin/api/webhooks/:id", hidden, async (req, reply) => {
    const { id } = req.params as { id: string };
    const w = await service.getWebhook(id);
    if (!w) return reply.status(404).send({ error: { code: "NOT_FOUND", message: "delivery" } });
    return w;
  });
  app.get("/admin/api/audit", hidden, (req) => service.listAudit(lim(req)));
  app.get("/admin/api/errors", hidden, (req) => service.listErrors(lim(req)));
  app.get("/admin/api/killswitch", hidden, () => service.killSwitchState());

  // ── Safe control API (audited) ──────────────────────────────────────────────
  app.post("/admin/api/killswitch/engage", hidden, async (req) => {
    need(req, "admin.killswitch");
    const reason = ((req.body ?? {}) as { reason?: string }).reason ?? "unspecified";
    await mutate(req, "killswitch.engage", "global", { reason }, () =>
      service.engageKillSwitch(reason),
    );
    return service.killSwitchState();
  });
  app.post("/admin/api/killswitch/reset", hidden, async (req) => {
    need(req, "admin.killswitch");
    await mutate(req, "killswitch.reset", "global", undefined, () => service.resetKillSwitch());
    return service.killSwitchState();
  });
  app.post("/admin/api/webhooks/:id/replay", hidden, async (req, reply) => {
    need(req, "admin.tenants.manage");
    const { id } = req.params as { id: string };
    const ok = await mutate(req, "webhook.replay", id, undefined, () => service.replayWebhook(id));
    if (!ok) return reply.status(404).send({ error: { code: "NOT_FOUND", message: "delivery" } });
    return { id, status: "pending" };
  });
  app.post("/admin/api/webhooks/:id/cancel", hidden, async (req, reply) => {
    need(req, "admin.tenants.manage");
    const { id } = req.params as { id: string };
    const ok = await mutate(req, "webhook.cancel", id, undefined, () => service.cancelWebhook(id));
    if (!ok) return reply.status(404).send({ error: { code: "NOT_FOUND", message: "delivery" } });
    return { id, status: "dead" };
  });
  app.post("/admin/api/tenants", hidden, async (req, reply) => {
    need(req, "admin.tenants.manage");
    const body = (req.body ?? {}) as { name?: string; scopes?: unknown };
    const name = body.name;
    if (!name) return reply.status(400).send({ error: { code: "BAD_REQUEST", message: "name" } });
    // Optional `scopes` — omitted means all three, which is the right default for
    // a tenant's FIRST key. The point is that a restricted one can now be asked for.
    const scopes = parseScopes(body.scopes);
    // Audit records the tenant name and the scopes granted, never the API key.
    const created = (await mutate(req, "tenant.create", name, { name, scopes }, () =>
      service.createTenant(name, scopes),
    )) as Awaited<ReturnType<AdminService["createTenant"]>>;
    return reply.status(201).send({ ...created, scopes });
  });
  // Lost-key recovery: issue an ADDITIONAL key for a tenant. The plaintext is
  // returned once and only its hash is stored; the audit records the tenant id,
  // never the key.
  app.post("/admin/api/tenants/:id/keys", hidden, async (req, reply) => {
    need(req, "admin.tenants.manage");
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { scopes?: unknown; label?: string };
    // This is how separation of duties is actually configured: issue the second
    // credential as {"scopes":["approve"]} and it can sign off on a held payout
    // without being able to request one. Every key used to carry every scope,
    // which made the documented boundary impossible to express.
    const scopes = parseScopes(body.scopes);
    const apiKey = (await mutate(req, "tenant.issue_key", id, { scopes, label: body.label }, () =>
      service.issueKey(id, scopes, body.label),
    )) as string;
    return reply.status(201).send({ tenantId: id, apiKey, scopes });
  });

  // Credential identity and status. Never the keys themselves — only their hashes
  // are stored, so a leaked key cannot be read back out of here either.
  app.get("/admin/api/tenants/:id/keys", hidden, async (req) => {
    const { id } = req.params as { id: string };
    return { tenantId: id, keys: await service.listKeys(id) };
  });

  // Rotation: mint a replacement and revoke every key that was live, atomically.
  // This is the endpoint for a LEAKED or lost key — unlike `POST .../keys`, the old
  // credentials stop working. The audit records which key ids were retired.
  app.post("/admin/api/tenants/:id/keys/rotate", hidden, async (req, reply) => {
    need(req, "admin.tenants.manage");
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { reason?: string; scopes?: unknown };
    const reason = body.reason;
    const scopes = parseScopes(body.scopes);
    const out = (await mutate(req, "tenant.rotate_keys", id, { reason, scopes }, async () => {
      const r = await service.rotateKeys(id, reason, scopes);
      // Audit the ids that were retired, never the plaintext that was issued.
      return r;
    })) as Awaited<ReturnType<AdminService["rotateKeys"]>>;
    await service.recordAudit({
      actor: actorOf(req),
      action: "tenant.keys_revoked",
      target: id,
      params: { revokedKeyIds: out.revokedKeyIds, replacedBy: out.keyId },
      result: "ok",
      ip: req.ip,
    });
    return reply.status(201).send({
      tenantId: id,
      apiKey: out.apiKey,
      keyId: out.keyId,
      scopes,
      revoked: out.revokedKeyIds,
    });
  });

  // ── Operator accounts ───────────────────────────────────────────────────────
  app.get("/admin/api/operators", hidden, async (req) => {
    need(req, "admin.operators.manage");
    return { operators: await authStore.listPrincipals("operator") };
  });

  app.post("/admin/api/operators", hidden, async (req, reply) => {
    need(req, "admin.operators.manage");
    const body = (req.body ?? {}) as { email?: string; password?: string; role?: string };
    if (!body.email || !body.password || !body.role) {
      return reply
        .status(400)
        .send({ error: { code: "BAD_REQUEST", message: "email, password and role are required" } });
    }
    if (body.password.length < 12) {
      return reply.status(400).send({
        error: { code: "BAD_REQUEST", message: "Password must be at least 12 characters" },
      });
    }
    // The audit records who was created and with what role, never the password.
    const created = (await mutate(
      req,
      "operator.create",
      body.email,
      { email: body.email, role: body.role },
      () =>
        authStore.createPrincipal({
          kind: "operator",
          email: body.email as string,
          password: body.password as string,
          role: body.role as string,
          // They set their own on first sign-in; the one issued here is a handover
          // value and must not survive it.
          mustChangePassword: true,
        }),
    )) as Awaited<ReturnType<AuthStore["createPrincipal"]>>;
    return reply.status(201).send({ operator: created });
  });

  app.post("/admin/api/operators/:id/disable", hidden, async (req) => {
    need(req, "admin.operators.manage");
    const { id } = req.params as { id: string };
    await mutate(req, "operator.disable", id, undefined, async () => {
      await authStore.setStatus(id, "disabled");
      return true;
    });
    return { id, status: "disabled" };
  });

  app.post("/admin/api/operators/:id/enable", hidden, async (req) => {
    need(req, "admin.operators.manage");
    const { id } = req.params as { id: string };
    await mutate(req, "operator.enable", id, undefined, async () => {
      await authStore.setStatus(id, "active");
      return true;
    });
    return { id, status: "active" };
  });

  /** Sign someone out everywhere — the control you reach for when a laptop is lost. */
  app.post("/admin/api/operators/:id/revoke-sessions", hidden, async (req) => {
    need(req, "admin.operators.manage");
    const { id } = req.params as { id: string };
    const revoked = (await mutate(req, "operator.revoke_sessions", id, undefined, () =>
      authStore.revokeAllSessions(id, "revoked by an administrator"),
    )) as number;
    return { id, revoked };
  });

  // ── Tenant users ────────────────────────────────────────────────────────────
  app.get("/admin/api/tenants/:id/users", hidden, async (req) => {
    need(req, "admin.tenants.manage");
    const { id } = req.params as { id: string };
    return { tenantId: id, users: await authStore.listPrincipals("tenant_user", id) };
  });

  app.post("/admin/api/tenants/:id/users", hidden, async (req, reply) => {
    need(req, "admin.tenants.manage");
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { email?: string; password?: string; role?: string };
    if (!body.email || !body.password || !body.role) {
      return reply
        .status(400)
        .send({ error: { code: "BAD_REQUEST", message: "email, password and role are required" } });
    }
    const created = (await mutate(
      req,
      "tenant_user.create",
      id,
      { email: body.email, role: body.role },
      () =>
        authStore.createPrincipal({
          kind: "tenant_user",
          tenantId: id,
          email: body.email as string,
          password: body.password as string,
          role: body.role as string,
          mustChangePassword: true,
        }),
    )) as Awaited<ReturnType<AuthStore["createPrincipal"]>>;
    return reply.status(201).send({ user: created });
  });

  /** Sign-in attempts across the whole engine — the record you read during an incident. */
  app.get("/admin/api/auth-attempts", hidden, async (req) => {
    need(req, "admin.operators.manage");
    return { attempts: await authStore.listAttempts(lim(req) ?? 100) };
  });

  // Revoke ONE credential, leaving the tenant's other keys alone.
  app.post("/admin/api/tenants/:id/keys/:keyId/revoke", hidden, async (req, reply) => {
    need(req, "admin.tenants.manage");
    const { id, keyId } = req.params as { id: string; keyId: string };
    const reason = ((req.body ?? {}) as { reason?: string }).reason;
    const ok = await mutate(req, "tenant.revoke_key", id, { keyId, reason }, () =>
      service.revokeKey(id, keyId, reason),
    );
    if (!ok) {
      return reply
        .status(404)
        .send({ error: { code: "NOT_FOUND", message: "key not found or already revoked" } });
    }
    return { tenantId: id, keyId, revoked: true };
  });
}
