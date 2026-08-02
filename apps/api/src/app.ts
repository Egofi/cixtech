import { randomUUID } from "node:crypto";
import { assetRegistry } from "@cixtech/chain-config";
import { UnsupportedChainError } from "@cixtech/chains";
import { AppError, type ErrorSink, captureError } from "@cixtech/errors";
import { Asset, LedgerAccountKey } from "@cixtech/types";
import fastifySwagger from "@fastify/swagger";
import scalarApiReference from "@scalar/fastify-api-reference";
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
import { registerPortal } from "./portal/portal-routes.js";
import { PortalService } from "./portal/portal-service.js";
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
  setWebhookSchema,
  withdrawalSchema,
} from "./schemas.js";
import { ForbiddenScopeError, type Scope, type Tenant, UnauthorizedError } from "./stores.js";

const STATUS: Record<string, number> = {
  UNAUTHORIZED: 401,
  ACCOUNT_NOT_FOUND: 404,
  POLICY_DENIED: 403,
  POLICY_APPROVAL_REQUIRED: 202,
  POLICY_TIME_LOCKED: 202,
  POLICY_COMPLIANCE_HOLD: 403,
  AUTHORIZATION_INVALID: 403,
  BAD_REQUEST: 400,
  FORBIDDEN_SCOPE: 403,
  POLICY_SELF_APPROVAL: 403,
  VALIDATION: 400,
  UNSUPPORTED_CHAIN: 400,
  LEDGER_INSUFFICIENT_FUNDS: 409,
  LEDGER_UNKNOWN_ENTRY: 409,
  WITHDRAWAL_NOT_FOUND: 404,
  POOL_INSUFFICIENT_FUNDS: 409,
};

const WEBHOOK_SECRET_PREFIX = "cxs_";
/** Policy outcomes that HOLD a payout rather than failing it — the intent survives. */
const HELD_CODES = new Set(["POLICY_APPROVAL_REQUIRED", "POLICY_TIME_LOCKED"]);
const DEFAULT_LOGGER: FastifyServerOptions["logger"] = {
  level: process.env["LOG_LEVEL"] ?? "info",
};

const header = (req: FastifyRequest, name: string): string | undefined => {
  const v = req.headers[name];
  return typeof v === "string" ? v : undefined;
};

/**
 * Auth is skipped for operational, docs, admin-plane, and portal-shell routes
 * (admin has its own auth; the portal shell is static — its data calls hit /v1
 * with the tenant API key).
 */
const isPublic = (url: string): boolean =>
  url === "/health" ||
  url === "/ready" ||
  url === "/metrics" ||
  url.startsWith("/docs") ||
  url.startsWith("/admin") ||
  url.startsWith("/portal");

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
  // Scalar reference UI (assets bundled in the plugin — no CDN): sidebar nav,
  // auth panel for the API key, and a per-route "Test Request" client.
  await app.register(scalarApiReference, { routePrefix: "/docs" });
  installMetrics(app);

  /**
   * The authenticated tenant, asserting the key carries `scope` (build spec §16).
   * Scopes are checked per route rather than globally because they encode
   * separation of duties: `approve` must not imply `move-funds`, so a key that can
   * sign off on a payout cannot also create one.
   */
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
    const tenant = tenantOf(req, "move-funds");
    const { url } = req.body as { url: string };
    const secret = `${WEBHOOK_SECRET_PREFIX}${randomUUID().replace(/-/g, "")}`;
    await engine.webhookEndpoints.set(tenant.id, url, secret);
    await reply.status(201).send({ url, secret });
  });

  app.post("/v1/accounts", { schema: createAccountSchema }, async (req, reply) => {
    const tenant = tenantOf(req, "move-funds");
    const { externalRef } = (req.body ?? {}) as { externalRef?: string };
    const account = await engine.tenants.createAccount(tenant.id, externalRef ?? null);
    await reply.status(201).send({ id: account.id, externalRef: account.externalRef });
  });

  // Resolved once at registration: the token registry is static config, and a
  // display layer that has to ask per request is a display layer that will cache
  // it wrong.
  const assets = assetRegistry();

  app.get("/v1/chains", { schema: chainsSchema }, async (req) => {
    tenantOf(req);
    // `assets` carries decimals because the ledger speaks integer base units:
    // without it a client cannot tell 4.34 USDT from 4,340,000 of them.
    return { chains: engine.chains.chains(), assets };
  });

  // ── Tenant-scoped activity reads (feeds the portal + interactive docs) ────────
  const portal = new PortalService(engine.sql);
  const limitOf = (req: FastifyRequest): number =>
    Math.min(Number((req.query as { limit?: string }).limit ?? 50), 200);

  app.get("/v1/accounts", { schema: listAccountsSchema }, async (req) => {
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
    "/v1/accounts/:id/deposit-addresses",
    { schema: listDepositAddressesSchema },
    async (req) => {
      const tenant = tenantOf(req);
      const { id } = req.params as { id: string };
      await engine.tenants.requireAccount(tenant.id, id);
      return { addresses: await portal.depositAddresses(tenant.id, id) };
    },
  );

  app.get("/v1/balances", { schema: listBalancesSchema }, async (req) => {
    const tenant = tenantOf(req);
    return { balances: await portal.balances(tenant.id) };
  });

  app.get("/v1/deposits", { schema: listDepositsSchema }, async (req) => {
    const tenant = tenantOf(req);
    return { deposits: await portal.deposits(tenant.id, limitOf(req)) };
  });

  app.get("/v1/payouts", { schema: listPayoutsSchema }, async (req) => {
    const tenant = tenantOf(req);
    return { payouts: await portal.payouts(tenant.id, limitOf(req)) };
  });

  app.get("/v1/allowlist", { schema: listAllowlistSchema }, async (req) => {
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

  app.get("/v1/webhook", { schema: getWebhookSchema }, async (req) => {
    const tenant = tenantOf(req);
    return portal.webhookEndpoint(tenant.id);
  });

  app.get("/v1/webhook/deliveries", { schema: listWebhookDeliveriesSchema }, async (req) => {
    const tenant = tenantOf(req);
    return { deliveries: await portal.webhookDeliveries(tenant.id, limitOf(req)) };
  });

  app.post(
    "/v1/accounts/:id/deposit-addresses",
    { schema: depositAddressSchema },
    async (req, reply) => {
      const tenant = tenantOf(req, "move-funds");
      const { id } = req.params as { id: string };
      await engine.tenants.requireAccount(tenant.id, id);
      // Canonicalize the chain so stored addresses match the detection loop's keys.
      const chain = (req.body as { chain: string }).chain.toUpperCase();
      const asset = (req.body as { asset: string }).asset.toUpperCase();
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
      await reply.status(201).send({ address, chain, asset });
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

  app.post("/v1/accounts/:id/allowlist", { schema: allowlistSchema }, async (req, reply) => {
    const tenant = tenantOf(req, "move-funds");
    const { id } = req.params as { id: string };
    await engine.tenants.requireAccount(tenant.id, id);
    const { chain, address } = req.body as { chain: string; address: string };
    // Cool-down applies (§7.2): the destination is unusable until usableAt, so a
    // compromised console cannot add an address and drain to it in one session.
    const { usableAt } = await engine.allowlist.add(
      tenant.id,
      id,
      chain.toUpperCase(),
      address,
      engine.allowlistCooldownMs,
    );
    await reply
      .status(201)
      .send({ chain: chain.toUpperCase(), address, usableAt: usableAt.toISOString() });
  });

  app.post("/v1/accounts/:id/withdrawals", { schema: withdrawalSchema }, async (req, reply) => {
    const tenant = tenantOf(req, "move-funds");
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
        // The requesting CREDENTIAL, not the tenant: separation of duties compares
        // keys, so a second key on the same tenant is a valid approver and this
        // one never is (§7.4).
        requester: tenant.keyId,
      });
      const body = { txId: result.txId, from: result.from, status: result.status };
      await engine.idempotency.complete(tenant.id, key, 200, body);
      await reply.send(body);
    } catch (err) {
      await engine.idempotency.release(tenant.id, key);
      // A payout held for approval or a time-lock is not a failure — the intent is
      // durably recorded and addressable. Return its id so the caller can route it
      // to an approver instead of being told only "202" with nowhere to go.
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
  });

  /**
   * Record one approval against a held payout (build spec §16, §7.4).
   *
   * Needs the `approve` scope, which no `move-funds` key implies — so the
   * credential that requested the payout structurally cannot approve it. When the
   * quorum is met the payout resumes on its original idempotency key, which means
   * it picks up the recorded intent rather than starting a second one.
   */
  app.post(
    "/v1/withdrawals/:id/approve",
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

  // Admin console + control plane (ADR 0015): separate bearer auth, all-tenant
  // reads, safe audited controls. Registered even when disabled so /admin returns
  // a clear "disabled" 401 rather than a 404.
  const adminService = new AdminService(engine.sql, engine, opts.admin?.limits ?? DEFAULT_LIMITS);
  registerAdmin(app, { service: adminService, token: opts.admin?.token });

  // Tenant portal (dashboard) — static SPA shell; its data calls hit /v1 with the
  // tenant API key, so the shell itself needs no server-side auth.
  registerPortal(app);

  await app.ready();
  return app;
}
