import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { UnauthorizedError } from "../stores.js";
import type { AdminService } from "./admin-service.js";
import { ADMIN_CSS, ADMIN_HTML, ADMIN_JS } from "./ui.js";

const ACTOR = "super_admin"; // v1 single admin (ADR 0015); RBAC/actor identity is a follow-up

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
  /** The super-admin bearer token. When absent, the admin plane is disabled entirely. */
  token: string | undefined;
}

/**
 * Mounts the admin console (ADR 0015): the static SPA at `/admin` and the JSON API
 * at `/admin/api/*`. The API is guarded by a bearer token separate from tenant API
 * keys, and every mutation is written to the append-only admin audit trail —
 * including failed attempts. Reads span all tenants; controls are limited to
 * operations that cannot move value outside MPC + policy.
 */
export function registerAdmin(app: FastifyInstance, opts: AdminOptions): void {
  const { service, token } = opts;

  // Guard only the JSON API; the SPA shell itself is static and unprivileged.
  app.addHook("onRequest", async (req) => {
    if (!req.url.startsWith("/admin/api")) return;
    if (!token) throw new UnauthorizedError("Admin plane is disabled");
    const provided = bearer(req);
    if (!provided || !tokenMatches(provided, token)) {
      throw new UnauthorizedError("Invalid admin token");
    }
  });

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
      await service.recordAudit({ actor: ACTOR, action, target, params, result: "ok", ip: req.ip });
      return out;
    } catch (err) {
      await service.recordAudit({
        actor: ACTOR,
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
  const html = (reply: FastifyReply, type: string, body: string) =>
    reply.header("content-type", type).send(body);

  // ── Static console ──────────────────────────────────────────────────────────
  app.get("/admin", hidden, async (_req, reply) =>
    html(reply, "text/html; charset=utf-8", ADMIN_HTML),
  );
  app.get("/admin/app.js", hidden, async (_req, reply) =>
    html(reply, "application/javascript; charset=utf-8", ADMIN_JS),
  );
  app.get("/admin/styles.css", hidden, async (_req, reply) =>
    html(reply, "text/css; charset=utf-8", ADMIN_CSS),
  );

  // ── Read API ────────────────────────────────────────────────────────────────
  const q = (req: FastifyRequest) => req.query as Record<string, string | undefined>;
  const lim = (req: FastifyRequest) => {
    const v = q(req)["limit"];
    return v ? Number(v) : undefined;
  };

  app.get("/admin/api/overview", hidden, () => service.overview());
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
    const reason = ((req.body ?? {}) as { reason?: string }).reason ?? "unspecified";
    await mutate(req, "killswitch.engage", "global", { reason }, () =>
      service.engageKillSwitch(reason),
    );
    return service.killSwitchState();
  });
  app.post("/admin/api/killswitch/reset", hidden, async (req) => {
    await mutate(req, "killswitch.reset", "global", undefined, () => service.resetKillSwitch());
    return service.killSwitchState();
  });
  app.post("/admin/api/webhooks/:id/replay", hidden, async (req, reply) => {
    const { id } = req.params as { id: string };
    const ok = await mutate(req, "webhook.replay", id, undefined, () => service.replayWebhook(id));
    if (!ok) return reply.status(404).send({ error: { code: "NOT_FOUND", message: "delivery" } });
    return { id, status: "pending" };
  });
  app.post("/admin/api/webhooks/:id/cancel", hidden, async (req, reply) => {
    const { id } = req.params as { id: string };
    const ok = await mutate(req, "webhook.cancel", id, undefined, () => service.cancelWebhook(id));
    if (!ok) return reply.status(404).send({ error: { code: "NOT_FOUND", message: "delivery" } });
    return { id, status: "dead" };
  });
  app.post("/admin/api/tenants", hidden, async (req, reply) => {
    const name = ((req.body ?? {}) as { name?: string }).name;
    if (!name) return reply.status(400).send({ error: { code: "BAD_REQUEST", message: "name" } });
    // Audit records the tenant name, never the API key that is returned.
    const created = (await mutate(req, "tenant.create", name, { name }, () =>
      service.createTenant(name),
    )) as Awaited<ReturnType<AdminService["createTenant"]>>;
    return reply.status(201).send(created);
  });
  // Lost-key recovery: issue an ADDITIONAL key for a tenant. The plaintext is
  // returned once and only its hash is stored; the audit records the tenant id,
  // never the key.
  app.post("/admin/api/tenants/:id/keys", hidden, async (req, reply) => {
    const { id } = req.params as { id: string };
    const apiKey = (await mutate(req, "tenant.issue_key", id, undefined, () =>
      service.issueKey(id),
    )) as string;
    return reply.status(201).send({ tenantId: id, apiKey });
  });
}
