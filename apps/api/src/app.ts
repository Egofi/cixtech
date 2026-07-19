import { randomUUID } from "node:crypto";
import { AppError, type ErrorSink, InMemoryErrorSink, captureError } from "@cixtech/errors";
import { Asset, LedgerAccountKey } from "@cixtech/types";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import type { Engine } from "./engine.js";
import { type Tenant, UnauthorizedError } from "./stores.js";

class BadRequestError extends AppError {
  readonly code = "BAD_REQUEST";
}

const STATUS: Record<string, number> = {
  UNAUTHORIZED: 401,
  ACCOUNT_NOT_FOUND: 404,
  POLICY_DENIED: 403,
  BAD_REQUEST: 400,
  LEDGER_INSUFFICIENT_FUNDS: 409,
  POOL_INSUFFICIENT_FUNDS: 409,
};

const header = (req: FastifyRequest, name: string): string | undefined => {
  const v = req.headers[name];
  return typeof v === "string" ? v : undefined;
};

function str(body: unknown, field: string): string {
  const v = (body as Record<string, unknown>)?.[field];
  if (typeof v !== "string" || v.length === 0) {
    throw new BadRequestError(`Missing or invalid field: ${field}`, { exposable: true });
  }
  return v;
}

export interface AppOptions {
  errorSink?: ErrorSink;
}

/**
 * The tenant-facing HTTP API (build spec §16). All routes are API-key
 * authenticated and tenant-isolated. Tenant onboarding (creating a tenant + key)
 * is an ops concern, not exposed here. Fastify is the HTTP engine; a NestJS
 * module wrapper is a later structural option.
 */
export function buildApp(engine: Engine, opts: AppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: false });
  const errorSink = opts.errorSink ?? new InMemoryErrorSink();
  const authed = new WeakMap<FastifyRequest, Tenant>();
  const idempotency = new Map<string, { status: number; body: unknown }>(); // in-memory; DB-backed in prod

  const tenantOf = (req: FastifyRequest): Tenant => {
    const t = authed.get(req);
    if (!t) throw new UnauthorizedError("Not authenticated");
    return t;
  };

  app.addHook("onRequest", async (req) => {
    if (req.url === "/health") return;
    authed.set(req, await engine.tenants.authenticate(header(req, "x-api-key")));
  });

  app.setErrorHandler(async (err, _req, reply) => {
    const record = await captureError(errorSink, err);
    if (err instanceof AppError) {
      await reply.status(STATUS[err.code] ?? 400).send({ error: err.toPublic() });
      return;
    }
    await reply
      .status(500)
      .send({ error: { id: record.id, code: "INTERNAL", message: "Internal error" } });
  });

  app.get("/health", async () => ({ status: "ok" }));

  // Create a sub-account (a tenant's merchant).
  app.post("/v1/accounts", async (req, reply) => {
    const tenant = tenantOf(req);
    const externalRef = (req.body as Record<string, unknown>)?.["externalRef"];
    const account = await engine.tenants.createAccount(
      tenant.id,
      typeof externalRef === "string" ? externalRef : null,
    );
    await reply.status(201).send({ id: account.id, externalRef: account.externalRef });
  });

  // Assign a pooled deposit address for a chain.
  app.post("/v1/accounts/:id/deposit-addresses", async (req, reply) => {
    const tenant = tenantOf(req);
    const { id } = req.params as { id: string };
    await engine.tenants.requireAccount(tenant.id, id);
    const chain = str(req.body, "chain");
    const address = await engine.pool.assign(tenant.id, id, chain, randomUUID(), engine.engineXpub);
    await reply.status(201).send({ address, chain });
  });

  // Per-asset available balance.
  app.get("/v1/accounts/:id/balance", async (req, reply) => {
    const tenant = tenantOf(req);
    const { id } = req.params as { id: string };
    await engine.tenants.requireAccount(tenant.id, id);
    const asset = (req.query as Record<string, unknown>)?.["asset"];
    if (typeof asset !== "string") throw new BadRequestError("asset query param required");
    const available = await engine.ledger.availableBalance(
      LedgerAccountKey(`merchant_available:${tenant.id}:${id}`),
      Asset(asset),
    );
    await reply.send({ asset: asset.toUpperCase(), available: available.toString() });
  });

  // Request a payout (guarded: policy → gather → lock → sign+broadcast → settle).
  app.post("/v1/accounts/:id/withdrawals", async (req, reply) => {
    const tenant = tenantOf(req);
    const { id } = req.params as { id: string };
    await engine.tenants.requireAccount(tenant.id, id);

    const key = header(req, "idempotency-key");
    if (!key) throw new BadRequestError("Idempotency-Key header required");
    const idemKey = `${tenant.id}:${key}`;
    const cached = idempotency.get(idemKey);
    if (cached) {
      await reply.status(cached.status).send(cached.body);
      return;
    }

    const chain = str(req.body, "chain");
    const asset = str(req.body, "asset");
    const amount = str(req.body, "amount");
    const destination = str(req.body, "destination");

    const result = await engine.payouts.payout({
      tenant: tenant.id,
      merchant: id,
      chain,
      asset,
      amountBaseUnits: BigInt(amount),
      destination,
      idempotencyKey: idemKey,
    });
    const body = { txId: result.txId, from: result.from, status: result.status };
    idempotency.set(idemKey, { status: 200, body });
    await reply.send(body);
  });

  return app;
}
