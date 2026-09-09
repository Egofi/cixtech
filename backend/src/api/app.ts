import { createHash, randomUUID } from "node:crypto";
import { AdminService, PortalService } from "@/services";
import { AuthStore, DEFAULT_SESSION_CONFIG as DEFAULT_SESSION_CONFIG_VALUES } from "@/stores";

import { scopesForTenantRole } from "@/auth";
import { assetRegistry, chainEnvOrNull } from "@/chain-config";
import {
  AppError,
  type ErrorSink,
  ForbiddenScopeError,
  PasswordChangeRequiredError,
  SqlErrorSink,
  UnauthorizedError,
  UnsupportedChainError,
  handleError,
  notFoundResponse,
} from "@/common";
import { SYSTEM_ROUTES, TENANT_ROUTES, accessForRoute, isPublicPrefix } from "@/common/routes";
import {
  type AdminPlaneOptions,
  Asset,
  type CookieOptions,
  LedgerAccountKey,
  type RateLimitOptions,
  type Scope,
  type SessionConfig,
  type Tenant,
} from "@/types";
import fastifyCors from "@fastify/cors";
import fastifyHelmet from "@fastify/helmet";
import fastifyRateLimit from "@fastify/rate-limit";
import fastifySwagger from "@fastify/swagger";
import scalarApiReference from "@scalar/fastify-api-reference";
import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyRequest,
  type FastifyServerOptions,
} from "fastify";
import { registerAdmin } from "./admin/admin-routes.js";

import { registerAi } from "./ai/ai-routes.js";
import { registerAuth } from "./auth/auth-routes.js";
import { DEFAULT_COOKIE_OPTIONS, resolveAuth } from "./auth/session-middleware.js";
import { assertValidDestination } from "./destination.js";
import type { Engine } from "./engine.js";
import { installMetrics } from "./metrics.js";

import {
  allowlistSchema,
  approveWithdrawalSchema,
  balanceSchema,
  chainsSchema,
  createAccountSchema,
  depositAddressSchema,
  getWebhookSchema,
  listAccountsSchema,
  listAllowlistSchema,
  listBalancesSchema,
  listDepositAddressesSchema,
  listDepositsSchema,
  listPayoutsSchema,
  listWebhookDeliveriesSchema,
  removeAllowlistSchema,
  setWebhookSchema,
  withdrawalSchema,
} from "@/schemas/http/api.schema.js";

import { runAsTenant } from "./tenant-scope.js";
import { assertPublicWebhookUrl } from "./webhook-url.js";

const WEBHOOK_SECRET_PREFIX = "cxs_";

const HELD_CODES = new Set(["POLICY_APPROVAL_REQUIRED", "POLICY_TIME_LOCKED"]);
const DEFAULT_LOGGER: FastifyServerOptions["logger"] = {
  level: process.env["LOG_LEVEL"] ?? "info",
};

const header = (req: FastifyRequest, name: string): string | undefined => {
  const v = req.headers[name];
  return typeof v === "string" ? v : undefined;
};

const needsTenantCredential = (req: FastifyRequest): boolean => {
  if (isPublicPrefix(req.url.split("?")[0] ?? req.url)) return false;
  return accessForRoute(req.method, req.routeOptions?.url)?.kind === "tenant";
};

export interface AppOptions {
  errorSink?: ErrorSink;
  logger?: FastifyServerOptions["logger"];
  admin?: AdminPlaneOptions;
  rateLimit?: RateLimitOptions;

  publicMetrics?: boolean;

  corsOrigins?: readonly string[];

  session?: Partial<SessionConfig>;

  cookie?: Partial<CookieOptions>;

  allowInsecureWebhooks?: boolean;
}

const DEFAULT_RATE_LIMIT = {
  max: 300,
  windowMs: 60_000,
  authFailureMax: 20,
} as const;

const DEFAULT_LIMITS = { maxPerPayout: "0", velocityWindowMs: 0, velocityMax: "0" };

export async function buildApp(engine: Engine, opts: AppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ?? DEFAULT_LOGGER,

    ajv: { customOptions: { removeAdditional: false } },
  });

  app.addContentTypeParser<string>(
    "application/json",
    { parseAs: "string" },
    (_req, body, done) => {
      if (body === undefined || body === null || String(body).trim() === "") {
        done(null, undefined);
        return;
      }
      try {
        done(null, JSON.parse(String(body)));
      } catch {
        const err = new Error("Body is not valid JSON") as Error & { statusCode: number };
        err.statusCode = 400;
        done(err, undefined);
      }
    },
  );

  const errorSink = opts.errorSink ?? new SqlErrorSink(engine.sql);
  const authed = new WeakMap<FastifyRequest, Tenant>();

  await app.register(fastifyHelmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:"],
        fontSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },

    strictTransportSecurity: { maxAge: 31_536_000, includeSubDomains: true },
    crossOriginEmbedderPolicy: false, // would break the bundled Scalar docs assets
    referrerPolicy: { policy: "no-referrer" },
  });

  const corsOrigins = opts.corsOrigins ?? [];
  if (corsOrigins.length > 0) {
    await app.register(fastifyCors, {
      origin: [...corsOrigins],
      methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
      allowedHeaders: [
        "content-type",
        "x-api-key",
        "authorization",
        "idempotency-key",
        "x-csrf-token",
      ],
      credentials: true,
      maxAge: 600,
    });
  }

  const rl = { ...DEFAULT_RATE_LIMIT, ...opts.rateLimit };
  if (opts.rateLimit?.enabled !== false) {
    await app.register(fastifyRateLimit, {
      global: true,
      max: (req) => (authed.has(req) ? rl.max : rl.authFailureMax),
      timeWindow: rl.windowMs,
      keyGenerator: (req) => {
        const key = header(req, "x-api-key");
        if (key) return `k:${createHash("sha256").update(key).digest("hex")}`;
        const admin = req.headers.authorization;
        if (typeof admin === "string") {
          return `a:${createHash("sha256").update(admin).digest("hex")}`;
        }
        return `ip:${req.ip}`;
      },

      allowList: (req) => req.url === "/health" || req.url === "/ready",
      errorResponseBuilder: (_req, ctx) => ({
        error: {
          code: "RATE_LIMITED",
          message: `Too many requests. Retry in ${Math.ceil(ctx.ttl / 1000)}s.`,
        },
      }),
    });
  }

  await app.register(fastifySwagger, {
    openapi: {
      info: {
        title: "cixtech Custody API",
        version: "0.1.0",
        description: [
          "Multi-tenant crypto-custody engine (Wallet-as-a-Service).",
          "",
          "## Authentication",
          "Every request carries your tenant API key in the `x-api-key` header",
          "(a `cxk_…` string, issued once when your tenant is created — the engine",
          "stores only its hash). Click **Auth** in the sidebar, paste the key, and",
          "every *Test Request* below sends it automatically.",
          "",
          "### Scopes",
          "Keys are scoped, and the split is a security boundary rather than",
          "convenience:",
          "",
          "| Scope | Grants |",
          "| --- | --- |",
          "| `read` | every `GET` |",
          "| `move-funds` | creating accounts, addresses, allow-list entries, payouts |",
          "| `approve` | approving a payout that is awaiting sign-off |",
          "",
          "`approve` does **not** imply `move-funds`. A payout above your approval",
          "threshold is held, and the credential that requested it can never approve",
          "it — so completing one always takes two distinct keys.",
          "",
          "## The flow",
          "1. **Create a sub-account** for each of your merchants/users.",
          "2. **Assign a deposit address** — pooled per account; deposits to it are",
          "   detected on-chain, credited at finality minus the platform fee, and",
          "   announced by signed webhook (`deposit.confirmed`).",
          "3. **Allow-list a destination** — a freshly added address is unusable",
          "   until its cool-down elapses (defeats add-and-drain).",
          "4. **Request a payout** — policy-guarded (limits, allow-list, velocity,",
          "   kill-switch, solvency), then signed, broadcast, and settled. The",
          "   `idempotency-key` header makes retries safe: one on-chain transfer, ever.",
          "5. **Approve it** if policy held it — a `202` returns a `withdrawalId`;",
          "   `POST /v1/withdrawals/{id}/approve` with an `approve`-scoped key",
          "   completes it once the quorum is met.",
          "",
          "The tenant dashboard lives at [/portal](/portal).",
        ].join("\n"),
      },
      tags: [
        {
          name: "accounts",
          description: "Sub-accounts (your merchants/users), balances, deposit addresses",
        },
        {
          name: "payouts",
          description: "Money-out: allow-list management and policy-guarded withdrawals",
        },
        {
          name: "ai",
          description:
            "Natural language financial sub-ledger query engine, risk anomaly feed & autonomous agentic rules",
        },
        {
          name: "webhooks",
          description:
            "Signed event delivery to your endpoint (at-least-once, HMAC `x-cixtech-signature`)",
        },
        { name: "chains", description: "Which chains this deployment routes" },
        {
          name: "activity",
          description: "Tenant-scoped history: deposits, payouts, webhook deliveries",
        },
      ],
      components: {
        securitySchemes: { apiKey: { type: "apiKey", name: "x-api-key", in: "header" } },
      },
      security: [{ apiKey: [] }],
    },
  });

  await app.register(scalarApiReference, { routePrefix: "/docs" });

  installMetrics(app, opts.publicMetrics ? {} : { token: opts.admin?.token });

  const tenantOf = (req: FastifyRequest, scope: Scope = "read"): Tenant => {
    const t = authed.get(req);
    if (!t) throw new UnauthorizedError("Not authenticated");
    if (!t.scopes.includes(scope)) {
      throw new ForbiddenScopeError(`This API key lacks the '${scope}' scope`, {
        context: { required: scope, granted: t.scopes.join(",") },
        exposable: true,
      });
    }
    return t;
  };

  app.addHook("onRequest", async (req) => {
    if (!needsTenantCredential(req)) return;

    const apiKey = header(req, "x-api-key");
    if (apiKey) {
      authed.set(req, await engine.tenants.authenticate(apiKey));
      return;
    }

    const ctx = await resolveAuth(authStore, req);
    if (ctx && ctx.principal.kind === "tenant_user" && ctx.principal.tenantId) {
      if (ctx.principal.mustChangePassword) {
        throw new PasswordChangeRequiredError("Set a new password before continuing", {
          exposable: true,
        });
      }
      authed.set(req, {
        id: ctx.principal.tenantId,
        name: ctx.principal.email,
        keyId: ctx.principal.id,
        scopes: scopesForTenantRole(ctx.principal.role),
      });
      return;
    }

    throw new UnauthorizedError("Missing API key", { exposable: true });
  });

  app.addHook("onRequest", (req, _reply, done) => {
    const tenant = authed.get(req);
    if (!tenant) {
      done();
      return;
    }
    runAsTenant(tenant.id, done);
  });

  app.setNotFoundHandler(async (req, reply) => {
    const resolved = notFoundResponse(req.method, req.url);
    await reply.status(resolved.status).send(resolved.body);
  });

  app.setErrorHandler(async (err: FastifyError, req, reply) => {
    const resolved = await handleError(err, {
      sink: errorSink,
      onCritical: (record) => req.log.error({ err: record }, "critical failure"),
    });
    await reply.status(resolved.status).send(resolved.body);
  });

  app.get(SYSTEM_ROUTES.HEALTH, { schema: { hide: true } }, async () => ({ status: "ok" }));

  app.get(SYSTEM_ROUTES.READY, { schema: { hide: true } }, async (_req, reply) => {
    try {
      await engine.sql.query("SELECT 1");
      return { status: "ready" };
    } catch {
      await reply.status(503).send({ status: "unavailable" });
      return reply;
    }
  });

  app.put(TENANT_ROUTES.WEBHOOK, { schema: setWebhookSchema }, async (req, reply) => {
    const tenant = tenantOf(req, "move-funds");
    const { url } = req.body as { url: string };

    await assertPublicWebhookUrl(url, { allowInsecure: opts.allowInsecureWebhooks === true });
    const secret = `${WEBHOOK_SECRET_PREFIX}${randomUUID().replace(/-/g, "")}`;
    await engine.webhookEndpoints.set(tenant.id, url, secret);
    await reply.status(201).send({ url, secret });
  });

  app.post(TENANT_ROUTES.ACCOUNTS, { schema: createAccountSchema }, async (req, reply) => {
    const tenant = tenantOf(req, "move-funds");
    const { externalRef } = (req.body ?? {}) as { externalRef?: string };
    const account = await engine.tenants.createAccount(tenant.id, externalRef ?? null);
    await reply.status(201).send({ id: account.id, externalRef: account.externalRef });
  });

  const assets = assetRegistry();

  app.get(TENANT_ROUTES.CHAINS, { schema: chainsSchema }, async (req) => {
    tenantOf(req);

    const env = chainEnvOrNull();
    return { chains: engine.chains.chains(), assets, ...(env ? { env } : {}) };
  });

  const portal = new PortalService(engine.sql);
  const limitOf = (req: FastifyRequest): number =>
    Math.min(Number((req.query as { limit?: string }).limit ?? 50), 200);

  app.get(TENANT_ROUTES.ACCOUNTS, { schema: listAccountsSchema }, async (req) => {
    const tenant = tenantOf(req);
    const accounts = await engine.tenants.listAccounts(tenant.id, limitOf(req));
    return {
      accounts: accounts.map((a) => ({
        id: a.id,
        externalRef: a.externalRef,
        createdAt: a.createdAt,
      })),
    };
  });

  app.get(
    TENANT_ROUTES.ACCOUNTS_BY_ID_DEPOSIT_ADDRESSES,
    { schema: listDepositAddressesSchema },
    async (req) => {
      const tenant = tenantOf(req);
      const { id } = req.params as { id: string };
      await engine.tenants.requireAccount(tenant.id, id);
      return { addresses: await portal.depositAddresses(tenant.id, id) };
    },
  );

  app.get(TENANT_ROUTES.BALANCES, { schema: listBalancesSchema }, async (req) => {
    const tenant = tenantOf(req);
    return { balances: await portal.balances(tenant.id) };
  });

  app.get(TENANT_ROUTES.DEPOSITS, { schema: listDepositsSchema }, async (req) => {
    const tenant = tenantOf(req);
    return { deposits: await portal.deposits(tenant.id, limitOf(req)) };
  });

  app.get(TENANT_ROUTES.PAYOUTS, { schema: listPayoutsSchema }, async (req) => {
    const tenant = tenantOf(req);
    return { payouts: await portal.payouts(tenant.id, limitOf(req)) };
  });

  app.get(TENANT_ROUTES.ALLOWLIST, { schema: listAllowlistSchema }, async (req) => {
    const tenant = tenantOf(req);
    const rows = await engine.allowlist.list(tenant.id, limitOf(req));
    return {
      allowlist: rows.map((r) => ({
        accountId: r.merchant,
        chain: r.chain,
        address: r.address,
        usableAt: r.usableAt.toISOString(),
        addedAt: r.addedAt.toISOString(),
      })),
    };
  });

  app.get(TENANT_ROUTES.WEBHOOK, { schema: getWebhookSchema }, async (req) => {
    const tenant = tenantOf(req);
    return portal.webhookEndpoint(tenant.id);
  });

  app.get(
    TENANT_ROUTES.WEBHOOK_DELIVERIES,
    { schema: listWebhookDeliveriesSchema },
    async (req) => {
      const tenant = tenantOf(req);
      return { deliveries: await portal.webhookDeliveries(tenant.id, limitOf(req)) };
    },
  );

  app.post(
    TENANT_ROUTES.ACCOUNTS_BY_ID_DEPOSIT_ADDRESSES,
    { schema: depositAddressSchema },
    async (req, reply) => {
      const tenant = tenantOf(req, "move-funds");
      const { id } = req.params as { id: string };
      await engine.tenants.requireAccount(tenant.id, id);

      const chain = (req.body as { chain: string }).chain.toUpperCase();
      const asset = (req.body as { asset: string }).asset.toUpperCase();

      if (!engine.chains.has(chain)) {
        throw new UnsupportedChainError(`Chain not supported: ${chain}`, {
          context: { chain, supported: engine.chains.chains().join(",") },
        });
      }
      const address = await engine.pool.assign(
        tenant.id,
        id,
        chain,
        randomUUID(),
        engine.engineXpub,
      );
      await reply.status(201).send({ address, chain, asset });
    },
  );

  app.get(TENANT_ROUTES.ACCOUNTS_BY_ID_BALANCE, { schema: balanceSchema }, async (req, reply) => {
    const tenant = tenantOf(req);
    const { id } = req.params as { id: string };
    await engine.tenants.requireAccount(tenant.id, id);
    const { asset } = req.query as { asset: string };
    const available = await engine.ledger.availableBalance(
      LedgerAccountKey(`merchant_available:${tenant.id}:${id}`),
      Asset(asset),
    );
    await reply.send({ asset: asset.toUpperCase(), available: available.toString() });
  });

  app.post(
    TENANT_ROUTES.ACCOUNTS_BY_ID_ALLOWLIST,
    { schema: allowlistSchema },
    async (req, reply) => {
      const tenant = tenantOf(req, "move-funds");
      const { id } = req.params as { id: string };
      await engine.tenants.requireAccount(tenant.id, id);
      const { chain, address } = req.body as { chain: string; address: string };
      const allowChain = chain.toUpperCase();
      if (!engine.chains.has(allowChain)) {
        throw new UnsupportedChainError(`Chain not supported: ${allowChain}`, {
          context: { chain: allowChain, supported: engine.chains.chains().join(",") },
        });
      }

      assertValidDestination(allowChain, address, engine.chains.familyOf(allowChain));

      const { usableAt } = await engine.allowlist.add(
        tenant.id,
        id,
        allowChain,
        address,
        engine.allowlistCooldownMs,
      );
      await reply
        .status(201)
        .send({ chain: allowChain, address, usableAt: usableAt.toISOString() });
    },
  );

  app.delete(
    TENANT_ROUTES.ACCOUNTS_BY_ID_ALLOWLIST,
    { schema: removeAllowlistSchema },
    async (req, reply) => {
      const tenant = tenantOf(req, "move-funds");
      const { id } = req.params as { id: string };
      await engine.tenants.requireAccount(tenant.id, id);
      const { chain, address } = req.query as { chain: string; address: string };
      const removed = await engine.allowlist.remove(tenant.id, id, chain.toUpperCase(), address);
      if (!removed) {
        await reply
          .status(404)
          .send({ error: { code: "NOT_FOUND", message: "Destination is not allow-listed" } });
        return;
      }
      await reply.send({ chain: chain.toUpperCase(), address, removed: true });
    },
  );

  app.post(
    TENANT_ROUTES.ACCOUNTS_BY_ID_WITHDRAWALS,
    { schema: withdrawalSchema },
    async (req, reply) => {
      const tenant = tenantOf(req, "move-funds");
      const { id } = req.params as { id: string };
      await engine.tenants.requireAccount(tenant.id, id);
      const withdrawChain = (req.body as { chain: string }).chain.toUpperCase();
      if (!engine.chains.has(withdrawChain)) {
        throw new UnsupportedChainError(`Chain not supported: ${withdrawChain}`, {
          context: { chain: withdrawChain, supported: engine.chains.chains().join(",") },
        });
      }

      assertValidDestination(
        withdrawChain,
        (req.body as { destination: string }).destination,
        engine.chains.familyOf(withdrawChain),
      );
      const key = header(req, "idempotency-key") as string;

      const replay = await engine.idempotency.begin(tenant.id, key);
      if (replay) {
        await reply.status(replay.status).send(replay.body);
        return;
      }

      try {
        const { asset, amount, destination } = req.body as {
          asset: string;
          amount: string;
          destination: string;
        };
        const result = await engine.payouts.payout({
          tenant: tenant.id,
          merchant: id,
          chain: withdrawChain,
          asset,
          amountBaseUnits: BigInt(amount),
          destination,
          idempotencyKey: `${tenant.id}:${key}`,

          requester: tenant.keyId,
        });
        const body = { txId: result.txId, from: result.from, status: result.status };
        await engine.idempotency.complete(tenant.id, key, 200, body);
        await reply.send(body);
      } catch (err) {
        await engine.idempotency.release(tenant.id, key);

        const held = await engine.payouts.findIntent(tenant.id, `${tenant.id}:${key}`);
        if (held && err instanceof AppError && HELD_CODES.has(err.code)) {
          await reply.status(202).send({
            withdrawalId: held.id,
            status: err.code === "POLICY_TIME_LOCKED" ? "TIME_LOCKED" : "PENDING_APPROVAL",
            ...(typeof err.context?.["needed"] === "number"
              ? { approvalsNeeded: err.context["needed"] as number }
              : {}),
            ...(typeof err.context?.["have"] === "number"
              ? { approvalsHave: err.context["have"] as number }
              : {}),
            ...(typeof err.context?.["until"] === "string"
              ? { until: err.context["until"] as string }
              : {}),
          });
          return;
        }
        throw err;
      }
    },
  );

  app.post(
    TENANT_ROUTES.WITHDRAWALS_BY_ID_APPROVE,
    { schema: approveWithdrawalSchema },
    async (req, reply) => {
      const tenant = tenantOf(req, "approve");
      const { id } = req.params as { id: string };
      const result = await engine.payouts.approve({
        tenant: tenant.id,
        withdrawalId: id,
        approver: tenant.keyId,
      });
      if (result.status === "settled") {
        await reply.send({
          withdrawalId: id,
          status: "settled",
          txId: result.txId,
          from: result.from,
          approvals: result.approvals,
        });
        return;
      }
      await reply.status(202).send({
        withdrawalId: id,
        status: "PENDING_APPROVAL",
        approvalsNeeded: result.needed,
        approvalsHave: result.approvals.length,
      });
    },
  );

  const authStore = new AuthStore(engine.sql, {
    ...DEFAULT_SESSION_CONFIG_VALUES,
    ...opts.session,
  });
  const cookieOptions: CookieOptions = { ...DEFAULT_COOKIE_OPTIONS, ...opts.cookie };
  registerAuth(app, {
    store: authStore,
    cookie: cookieOptions,

    tenantResolver: async (_email, hint) => hint ?? null,
  });

  const adminService = new AdminService(
    engine.sql,
    engine,
    opts.admin?.limits ?? DEFAULT_LIMITS,
    opts.admin?.feeTreasuryAddressFor,
  );
  registerAdmin(app, {
    service: adminService,
    token: opts.admin?.token,
    authStore,
  });

  registerAi(app, { engine, tenantOf });

  await app.ready();
  return app;
}
