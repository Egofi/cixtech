import { timingSafeEqual } from "node:crypto";
import type { AdminService } from "@/services";
import { type AuthStore, parseScopes } from "@/stores";

import { chainEnvOrNull } from "@/chain-config";
import { UnauthorizedError } from "@/common";
import { ADMIN_ROUTES, accessForRoute } from "@/common/routes";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { type AuthContext, requirePermission, resolveAuth } from "../auth/session-middleware.js";

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

  token: string | undefined;
  authStore: AuthStore;
}

export function registerAdmin(app: FastifyInstance, opts: AdminOptions): void {
  const { service, token, authStore } = opts;

  const actors = new WeakMap<FastifyRequest, { actor: string; ctx: AuthContext | null }>();

  app.addHook("onRequest", async (req) => {
    const access = accessForRoute(req.method, req.routeOptions?.url);
    if (access?.kind !== "operator") return;

    const ctx = await resolveAuth(authStore, req);
    if (ctx) {
      if (ctx.principal.kind !== "operator") {
        throw new UnauthorizedError("This session is not an operator account");
      }

      requirePermission(ctx, access.permission);
      actors.set(req, { actor: ctx.principal.email, ctx });
      return;
    }

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

  const actorOf = (req: FastifyRequest): string => actors.get(req)?.actor ?? STATIC_TOKEN_ACTOR;

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

  const q = (req: FastifyRequest) => req.query as Record<string, string | undefined>;
  const lim = (req: FastifyRequest) => {
    const v = q(req)["limit"];
    return v ? Number(v) : undefined;
  };

  app.get(ADMIN_ROUTES.OVERVIEW, hidden, () => service.overview());
  app.get(ADMIN_ROUTES.EARNINGS, hidden, () => service.earningsAnalysis());
  app.post(ADMIN_ROUTES.EARNINGS_SWEEP, hidden, async (req, reply) => {
    const asset = ((req.body ?? {}) as { asset?: string }).asset ?? "USDT";
    const res = await mutate(req, "earnings.sweep_fees", asset, { asset }, () =>
      service.sweepFees(asset),
    );
    return reply.status(200).send(res);
  });
  app.get(ADMIN_ROUTES.POOL_ADDRESSES, hidden, (req) => {
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
  app.get(ADMIN_ROUTES.WALLETS_VERIFY_ONCHAIN, hidden, (req, reply) => {
    const { chain, address, asset } = q(req);
    if (!chain || !address) {
      return reply
        .status(400)
        .send({ error: { code: "BAD_REQUEST", message: "chain and address required" } });
    }
    return service.verifyOnchainWallet(chain, address, asset);
  });

  app.get(ADMIN_ROUTES.ASSETS, hidden, () => ({ assets: service.assets(), env: chainEnvOrNull() }));
  app.get(ADMIN_ROUTES.TENANTS, hidden, () => service.listTenants());
  app.get(ADMIN_ROUTES.TENANTS_BY_ID, hidden, async (req, reply) => {
    const { id } = req.params as { id: string };
    const t = await service.getTenant(id);
    if (!t) return reply.status(404).send({ error: { code: "NOT_FOUND", message: "tenant" } });
    return t;
  });
  app.get(ADMIN_ROUTES.LEDGER_ACCOUNTS, hidden, () => service.ledgerAccounts());
  app.get(ADMIN_ROUTES.LEDGER_ENTRIES, hidden, (req) => {
    const { account, kind } = q(req);
    return service.entries({
      ...(account ? { account } : {}),
      ...(kind ? { kindPrefix: kind } : {}),
      ...(lim(req) !== undefined ? { limit: lim(req) } : {}),
    });
  });
  app.get(ADMIN_ROUTES.DEPOSITS, hidden, (req) => service.listDeposits(lim(req)));
  app.get(ADMIN_ROUTES.PAYOUTS, hidden, (req) => service.listPayouts(lim(req)));
  app.get(ADMIN_ROUTES.WEBHOOKS, hidden, (req) => {
    const status = q(req)["status"];
    return service.listWebhooks({
      ...(status ? { status } : {}),
      ...(lim(req) !== undefined ? { limit: lim(req) } : {}),
    });
  });
  app.get(ADMIN_ROUTES.WEBHOOKS_BY_ID, hidden, async (req, reply) => {
    const { id } = req.params as { id: string };
    const w = await service.getWebhook(id);
    if (!w) return reply.status(404).send({ error: { code: "NOT_FOUND", message: "delivery" } });
    return w;
  });
  app.get(ADMIN_ROUTES.AUDIT, hidden, (req) => service.listAudit(lim(req)));
  app.get(ADMIN_ROUTES.ERRORS, hidden, (req) => service.listErrors(lim(req)));
  app.get(ADMIN_ROUTES.KILLSWITCH, hidden, () => service.killSwitchState());

  app.post(ADMIN_ROUTES.KILLSWITCH_ENGAGE, hidden, async (req) => {
    const reason = ((req.body ?? {}) as { reason?: string }).reason ?? "unspecified";
    await mutate(req, "killswitch.engage", "global", { reason }, () =>
      service.engageKillSwitch(reason),
    );
    return service.killSwitchState();
  });
  app.post(ADMIN_ROUTES.KILLSWITCH_RESET, hidden, async (req) => {
    await mutate(req, "killswitch.reset", "global", undefined, () => service.resetKillSwitch());
    return service.killSwitchState();
  });
  app.post(ADMIN_ROUTES.WEBHOOKS_BY_ID_REPLAY, hidden, async (req, reply) => {
    const { id } = req.params as { id: string };
    const ok = await mutate(req, "webhook.replay", id, undefined, () => service.replayWebhook(id));
    if (!ok) return reply.status(404).send({ error: { code: "NOT_FOUND", message: "delivery" } });
    return { id, status: "pending" };
  });
  app.post(ADMIN_ROUTES.WEBHOOKS_BY_ID_CANCEL, hidden, async (req, reply) => {
    const { id } = req.params as { id: string };
    const ok = await mutate(req, "webhook.cancel", id, undefined, () => service.cancelWebhook(id));
    if (!ok) return reply.status(404).send({ error: { code: "NOT_FOUND", message: "delivery" } });
    return { id, status: "dead" };
  });
  app.post(ADMIN_ROUTES.TENANTS, hidden, async (req, reply) => {
    const body = (req.body ?? {}) as { name?: string; scopes?: unknown };
    const name = body.name;
    if (!name) return reply.status(400).send({ error: { code: "BAD_REQUEST", message: "name" } });

    const scopes = parseScopes(body.scopes);

    const created = (await mutate(req, "tenant.create", name, { name, scopes }, () =>
      service.createTenant(name, scopes),
    )) as Awaited<ReturnType<AdminService["createTenant"]>>;
    return reply.status(201).send({ ...created, scopes });
  });

  app.post(ADMIN_ROUTES.TENANTS_BY_ID_KEYS, hidden, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { scopes?: unknown; label?: string };

    const scopes = parseScopes(body.scopes);
    const apiKey = (await mutate(req, "tenant.issue_key", id, { scopes, label: body.label }, () =>
      service.issueKey(id, scopes, body.label),
    )) as string;
    return reply.status(201).send({ tenantId: id, apiKey, scopes });
  });

  app.get(ADMIN_ROUTES.TENANTS_BY_ID_KEYS, hidden, async (req) => {
    const { id } = req.params as { id: string };
    return { tenantId: id, keys: await service.listKeys(id) };
  });

  app.post(ADMIN_ROUTES.TENANTS_BY_ID_KEYS_ROTATE, hidden, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { reason?: string; scopes?: unknown };
    const reason = body.reason;
    const scopes = parseScopes(body.scopes);
    const out = (await mutate(req, "tenant.rotate_keys", id, { reason, scopes }, async () => {
      const r = await service.rotateKeys(id, reason, scopes);

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

  app.get(ADMIN_ROUTES.OPERATORS, hidden, async (req) => {
    return { operators: await authStore.listPrincipals("operator") };
  });

  app.post(ADMIN_ROUTES.OPERATORS, hidden, async (req, reply) => {
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

          mustChangePassword: true,
        }),
    )) as Awaited<ReturnType<AuthStore["createPrincipal"]>>;
    return reply.status(201).send({ operator: created });
  });

  app.post(ADMIN_ROUTES.OPERATORS_BY_ID_DISABLE, hidden, async (req) => {
    const { id } = req.params as { id: string };
    await mutate(req, "operator.disable", id, undefined, async () => {
      await authStore.setStatus(id, "disabled");
      return true;
    });
    return { id, status: "disabled" };
  });

  app.post(ADMIN_ROUTES.OPERATORS_BY_ID_ENABLE, hidden, async (req) => {
    const { id } = req.params as { id: string };
    await mutate(req, "operator.enable", id, undefined, async () => {
      await authStore.setStatus(id, "active");
      return true;
    });
    return { id, status: "active" };
  });

  app.post(ADMIN_ROUTES.OPERATORS_BY_ID_REVOKE_SESSIONS, hidden, async (req) => {
    const { id } = req.params as { id: string };
    const revoked = (await mutate(req, "operator.revoke_sessions", id, undefined, () =>
      authStore.revokeAllSessions(id, "revoked by an administrator"),
    )) as number;
    return { id, revoked };
  });

  app.get(ADMIN_ROUTES.TENANTS_BY_ID_USERS, hidden, async (req) => {
    const { id } = req.params as { id: string };
    return { tenantId: id, users: await authStore.listPrincipals("tenant_user", id) };
  });

  app.post(ADMIN_ROUTES.TENANTS_BY_ID_USERS, hidden, async (req, reply) => {
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

  app.get(ADMIN_ROUTES.AUTH_ATTEMPTS, hidden, async (req) => {
    return { attempts: await authStore.listAttempts(lim(req) ?? 100) };
  });

  app.post(ADMIN_ROUTES.TENANTS_BY_ID_KEYS_BY_KEY_ID_REVOKE, hidden, async (req, reply) => {
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
