import { randomUUID } from "node:crypto";
import { UnsupportedChainError } from "@cixtech/chains";
import { AppError, type ErrorSink, captureError } from "@cixtech/errors";
import { Asset, LedgerAccountKey } from "@cixtech/types";
import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUi from "@fastify/swagger-ui";
import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyRequest,
  type FastifyServerOptions,
} from "fastify";
import { registerAdmin } from "./admin/admin-routes.js";
import { AdminService } from "./admin/admin-service.js";
import { SqlErrorSink } from "./admin/sql-error-sink.js";
import type { Engine } from "./engine.js";
import { installMetrics } from "./metrics.js";
import {
  balanceSchema,
  createAccountSchema,
  depositAddressSchema,
  setWebhookSchema,
  withdrawalSchema,
} from "./schemas.js";
import { type Tenant, UnauthorizedError } from "./stores.js";

const STATUS: Record<string, number> = {
  UNAUTHORIZED: 401,
  ACCOUNT_NOT_FOUND: 404,
  POLICY_DENIED: 403,
  BAD_REQUEST: 400,
  VALIDATION: 400,
  UNSUPPORTED_CHAIN: 400,
  LEDGER_INSUFFICIENT_FUNDS: 409,
  POOL_INSUFFICIENT_FUNDS: 409,
};

const WEBHOOK_SECRET_PREFIX = "cxs_";
const DEFAULT_LOGGER: FastifyServerOptions["logger"] = {
  level: process.env["LOG_LEVEL"] ?? "info",
};

const header = (req: FastifyRequest, name: string): string | undefined => {
  const v = req.headers[name];
  return typeof v === "string" ? v : undefined;
};

/** Auth is skipped for operational and admin-plane routes (admin has its own auth). */
const isPublic = (url: string): boolean =>
  url === "/health" ||
  url === "/ready" ||
  url === "/metrics" ||
  url.startsWith("/docs") ||
  url.startsWith("/admin");

export interface AdminPlaneOptions {
  /** Super-admin bearer token. When unset, the admin plane is disabled. */
  token?: string | undefined;
  limits?: { maxPerPayout: string; velocityWindowMs: number; velocityMax: string };
}

export interface AppOptions {
  errorSink?: ErrorSink;
  logger?: FastifyServerOptions["logger"];
  admin?: AdminPlaneOptions;
}

const DEFAULT_LIMITS = { maxPerPayout: "0", velocityWindowMs: 0, velocityMax: "0" };

/**
 * The tenant-facing HTTP API (build spec §16). Every route is JSON-Schema
 * validated (which also generates the OpenAPI spec at /docs), API-key
 * authenticated, and tenant-isolated. Structured pino logs, Prometheus metrics
 * at /metrics, and /health + /ready round out the operational surface. Fastify is
 * the HTTP engine (bare, deliberately — see repo notes on NestJS).
 */
export async function buildApp(engine: Engine, opts: AppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ?? DEFAULT_LOGGER,
    // Reject unknown body fields (additionalProperties:false) rather than silently
    // stripping them — a wrong field name should fail loudly, not vanish.
    ajv: { customOptions: { removeAdditional: false } },
  });
  // Default to the durable SQL sink so the ADR 0012 trail is queryable in the admin console.
  const errorSink = opts.errorSink ?? new SqlErrorSink(engine.sql);
  const authed = new WeakMap<FastifyRequest, Tenant>();

  await app.register(fastifySwagger, {
    openapi: {
      info: { title: "cixtech Custody API", version: "0.1.0" },
      components: {
        securitySchemes: { apiKey: { type: "apiKey", name: "x-api-key", in: "header" } },
      },
      security: [{ apiKey: [] }],
    },
  });
  await app.register(fastifySwaggerUi, { routePrefix: "/docs" });
  installMetrics(app);

  const tenantOf = (req: FastifyRequest): Tenant => {
    const t = authed.get(req);
    if (!t) throw new UnauthorizedError("Not authenticated");
    return t;
  };

  app.addHook("onRequest", async (req) => {
    if (isPublic(req.url.split("?")[0] ?? req.url)) return;
    authed.set(req, await engine.tenants.authenticate(header(req, "x-api-key")));
  });

  app.setErrorHandler(async (err: FastifyError, _req, reply) => {
    const record = await captureError(errorSink, err);
    if (err.validation) {
      await reply
        .status(400)
        .send({ error: { id: record.id, code: "VALIDATION", message: err.message } });
      return;
    }
    if (err instanceof AppError) {
      await reply.status(STATUS[err.code] ?? 400).send({ error: err.toPublic() });
      return;
    }
    await reply
      .status(500)
      .send({ error: { id: record.id, code: "INTERNAL", message: "Internal error" } });
  });

  app.get("/health", { schema: { hide: true } }, async () => ({ status: "ok" }));

  app.get("/ready", { schema: { hide: true } }, async (_req, reply) => {
    try {
      await engine.sql.query("SELECT 1");
      return { status: "ready" };
    } catch {
      await reply.status(503).send({ status: "unavailable" });
      return reply;
    }
  });

  app.put("/v1/webhook", { schema: setWebhookSchema }, async (req, reply) => {
    const tenant = tenantOf(req);
    const { url } = req.body as { url: string };
    const secret = `${WEBHOOK_SECRET_PREFIX}${randomUUID().replace(/-/g, "")}`;
    await engine.webhookEndpoints.set(tenant.id, url, secret);
    await reply.status(201).send({ url, secret });
  });

  app.post("/v1/accounts", { schema: createAccountSchema }, async (req, reply) => {
    const tenant = tenantOf(req);
    const { externalRef } = (req.body ?? {}) as { externalRef?: string };
    const account = await engine.tenants.createAccount(tenant.id, externalRef ?? null);
    await reply.status(201).send({ id: account.id, externalRef: account.externalRef });
  });

  app.get("/v1/chains", { schema: { hide: true } }, async (req) => {
    tenantOf(req);
    return { chains: engine.chains.chains() };
  });

  app.post(
    "/v1/accounts/:id/deposit-addresses",
    { schema: depositAddressSchema },
    async (req, reply) => {
      const tenant = tenantOf(req);
      const { id } = req.params as { id: string };
      await engine.tenants.requireAccount(tenant.id, id);
      // Canonicalize the chain so stored addresses match the detection loop's keys.
      const chain = (req.body as { chain: string }).chain.toUpperCase();
      // Reject an unroutable chain BEFORE a pool index is consumed.
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
      await reply.status(201).send({ address, chain });
    },
  );

  app.get("/v1/accounts/:id/balance", { schema: balanceSchema }, async (req, reply) => {
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

  app.post("/v1/accounts/:id/withdrawals", { schema: withdrawalSchema }, async (req, reply) => {
    const tenant = tenantOf(req);
    const { id } = req.params as { id: string };
    await engine.tenants.requireAccount(tenant.id, id);
    const withdrawChain = (req.body as { chain: string }).chain.toUpperCase();
    if (!engine.chains.has(withdrawChain)) {
      throw new UnsupportedChainError(`Chain not supported: ${withdrawChain}`, {
        context: { chain: withdrawChain, supported: engine.chains.chains().join(",") },
      });
    }
    const key = header(req, "idempotency-key") as string; // required by schema

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
      });
      const body = { txId: result.txId, from: result.from, status: result.status };
      await engine.idempotency.complete(tenant.id, key, 200, body);
      await reply.send(body);
    } catch (err) {
      await engine.idempotency.release(tenant.id, key);
      throw err;
    }
  });

  // Admin console + control plane (ADR 0015): separate bearer auth, all-tenant
  // reads, safe audited controls. Registered even when disabled so /admin returns
  // a clear "disabled" 401 rather than a 404.
  const adminService = new AdminService(engine.sql, engine, opts.admin?.limits ?? DEFAULT_LIMITS);
  registerAdmin(app, { service: adminService, token: opts.admin?.token });

  await app.ready();
  return app;
}
