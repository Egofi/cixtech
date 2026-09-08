import { createHash, randomUUID } from "node:crypto";
import { assetRegistry, chainEnvOrNull } from "@cixtech/chain-config";
import { UnsupportedChainError } from "@cixtech/chains";
import { AppError, type ErrorSink, captureError } from "@cixtech/errors";
import { Asset, LedgerAccountKey } from "@cixtech/types";
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
import { AdminService } from "./admin/admin-service.js";
import { SqlErrorSink } from "./admin/sql-error-sink.js";
import { registerAi } from "./ai/ai-routes.js";
import { assertValidDestination } from "./destination.js";
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
  removeAllowlistSchema,
  setWebhookSchema,
  withdrawalSchema,
} from "./schemas.js";
import { ForbiddenScopeError, type Scope, type Tenant, UnauthorizedError } from "./stores.js";
import { runAsTenant } from "./tenant-scope.js";
import { assertPublicWebhookUrl } from "./webhook-url.js";

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
  INVALID_SCOPES: 400,
  UNSAFE_WEBHOOK_URL: 400,
  INVALID_DESTINATION: 400,
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
  /** Where collected fees go, per chain. Absent = the console refuses to sweep. */
  feeTreasuryAddressFor?: ((chain: string) => string | undefined) | undefined;
}

export interface RateLimitOptions {
  /** Requests per window for an authenticated tenant. */
  max?: number;
  /** Window length in milliseconds. */
  windowMs?: number;
  /** Much tighter bucket for requests that FAIL authentication, keyed on IP. */
  authFailureMax?: number;
  /** Disable entirely. Only for tests that deliberately hammer a route. */
  enabled?: boolean;
}

export interface AppOptions {
  errorSink?: ErrorSink;
  logger?: FastifyServerOptions["logger"];
  admin?: AdminPlaneOptions;
  rateLimit?: RateLimitOptions;
  /**
   * Require the admin bearer token for `/metrics`. Default true.
   *
   * The scrape endpoint publishes the Node version, process start time, heap and
   * event-loop detail, and per-route request counts with statuses — enough to
   * profile tenant activity and time an incident from outside. Set false only when
   * the port is bound to an internal interface a scraper reaches directly.
   */
  publicMetrics?: boolean;
  /**
   * Permit `http://` and private webhook targets. Development only — it re-opens
   * the SSRF in CX-09, so it is a deliberate boot-time choice.
   */
  allowInsecureWebhooks?: boolean;
}

const DEFAULT_RATE_LIMIT = {
  max: 300,
  windowMs: 60_000,
  authFailureMax: 20,
} as const;

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
  /**
   * An empty body with a JSON content-type parses to "no body" rather than being
   * rejected.
   *
   * Several mutations here take no body at all — releasing the kill-switch,
   * issuing a key, replaying a delivery — and the ones that do take a body treat
   * it as optional (`req.body ?? {}`). Fastify's default parser refuses the
   * combination outright, so any client that sets a JSON content-type once and
   * reuses it for every call (both of our consoles did) could engage the
   * kill-switch but never release it. A safety control that only latches one way
   * is worse than no control, and that is a contract the engine owes every
   * tenant's HTTP client, not just our own pages.
   *
   * Malformed JSON is still a hard 400 — this widens what counts as an empty
   * body, not what counts as valid JSON.
   */
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

  // Default to the durable SQL sink so the ADR 0012 trail is queryable in the admin console.
  const errorSink = opts.errorSink ?? new SqlErrorSink(engine.sql);
  const authed = new WeakMap<FastifyRequest, Tenant>();

  /**
   * Security response headers.
   *
   * Both consoles are served from this origin and hold a bearer credential in
   * localStorage — the super-admin token in one, a tenant API key in the other —
   * so script execution here reads both. The CSP is tight because the consoles
   * ship as inline strings we control: no external script, style or connect
   * origin is needed at all. `frame-ancestors 'none'` is the one that stops the
   * kill switch and the fee sweep from being clickjacked.
   *
   * `'unsafe-inline'` is present for script and style because the consoles ARE
   * inline; a nonce is the better answer and is a follow-up, not a reason to ship
   * no CSP at all. Scalar's docs UI also renders inline.
   */
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
    // HSTS is meaningful only over TLS, and the engine sits behind a terminating
    // proxy; a year with subdomains is the standard posture for a custody API.
    strictTransportSecurity: { maxAge: 31_536_000, includeSubDomains: true },
    crossOriginEmbedderPolicy: false, // would break the bundled Scalar docs assets
    referrerPolicy: { policy: "no-referrer" },
  });

  /**
   * Rate limiting (there was none).
   *
   * Two buckets, because they defend different things. The generous per-credential
   * bucket bounds a single tenant's traffic. The much tighter per-IP bucket applies
   * to requests that fail authentication, which is what caps credential guessing,
   * webhook-URL probing, and the unauthenticated audit-log writes below.
   *
   * Keyed on the API key's HASH, never the key: the limiter's internal store and
   * any error it logs must not become a place secrets accumulate.
   */
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
      // /health and /ready are what a load balancer polls; rate-limiting them
      // turns a traffic spike into a spurious instance eviction.
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
  // Scalar reference UI (assets bundled in the plugin — no CDN): sidebar nav,
  // auth panel for the API key, and a per-route "Test Request" client.
  await app.register(scalarApiReference, { routePrefix: "/docs" });
  // Scraping requires the admin token unless the deployment explicitly opts out
  // (e.g. the port is bound to an internal interface).
  installMetrics(app, opts.publicMetrics ? {} : { token: opts.admin?.token });

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

  /**
   * Enter the authenticated tenant's RLS scope for the rest of the request (§13).
   *
   * Callback style, not async: `AsyncLocalStorage.run(store, done)` carries the
   * context into the remaining hooks AND the route handler, because Fastify
   * continues the chain synchronously from `done()`. An `async` hook would exit
   * the context before the handler ever ran, which is the trap that leaves an
   * ALS-based scope silently doing nothing.
   *
   * With this bound, `tenantScopedSql` sets `cixtech.tenant` on every statement
   * the handler issues, so the row-level-security policies installed by rls.ts
   * finally constrain a tenant request instead of matching everything.
   */
  app.addHook("onRequest", (req, _reply, done) => {
    const tenant = authed.get(req);
    if (!tenant) {
      done();
      return;
    }
    runAsTenant(tenant.id, done);
  });

  /**
   * Errors that are the CALLER's fault and carry no diagnostic value are counted,
   * not persisted.
   *
   * `captureError` used to run for every error including authentication failures,
   * so one anonymous request equalled one row in `error_log` — an append-only
   * table the application role is deliberately denied DELETE on, meaning nothing
   * in the running system could trim it. With no rate limit that was an unbounded
   * write primitive for an unauthenticated caller, and it buried real incidents
   * under noise. These still surface in the Prometheus counters and the request
   * log; what they no longer do is accumulate forever in the audit trail.
   */
  const NOT_WORTH_PERSISTING = new Set([
    "UNAUTHORIZED",
    "FORBIDDEN_SCOPE",
    "VALIDATION",
    "RATE_LIMITED",
    "INVALID_SCOPES",
  ]);

  const capture = async (err: FastifyError): Promise<{ id: string }> => {
    const code = err instanceof AppError ? err.code : err.validation ? "VALIDATION" : err.code;
    if (code && NOT_WORTH_PERSISTING.has(code)) {
      return { id: err instanceof AppError ? err.id : randomUUID() };
    }
    return captureError(errorSink, err);
  };

  app.setErrorHandler(async (err: FastifyError, _req, reply) => {
    const record = await capture(err);
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
    // Fastify raises its own client errors — empty or malformed JSON body,
    // unsupported media type, payload too large — and they arrive here carrying
    // an accurate 4xx `statusCode`. Collapsing those into 500 tells the caller
    // the engine broke when the caller's request did, hides the one message that
    // says how to fix it, and fills the error log (and anything alerting on it)
    // with false internal faults. Only a genuine 5xx becomes an opaque INTERNAL.
    const status = typeof err.statusCode === "number" ? err.statusCode : 500;
    if (status >= 400 && status < 500) {
      await reply
        .status(status)
        .send({ error: { id: record.id, code: err.code ?? "BAD_REQUEST", message: err.message } });
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
    // Refuse loopback, link-local (cloud metadata), and private targets here so
    // the tenant gets an actionable 400 instead of a delivery that quietly probes
    // our own network. The poster re-checks at send time against DNS rebinding.
    await assertPublicWebhookUrl(url, { allowInsecure: opts.allowInsecureWebhooks === true });
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
    // `env` is which network this deployment is pointed at (§16.5) — a console
    // that shows balances must not leave the operator guessing. Absent rather
    // than fatal when unset: a label must never take down a data route.
    const env = chainEnvOrNull();
    return { chains: engine.chains.chains(), assets, ...(env ? { env } : {}) };
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
    const allowChain = chain.toUpperCase();
    if (!engine.chains.has(allowChain)) {
      throw new UnsupportedChainError(`Chain not supported: ${allowChain}`, {
        context: { chain: allowChain, supported: engine.chains.chains().join(",") },
      });
    }
    // Validate the address for THIS chain now, rather than letting a malformed or
    // wrong-chain destination sit on the allow-list until a payout fails on it
    // after taking a lease and locking funds.
    assertValidDestination(allowChain, address, engine.chains.familyOf(allowChain));
    // Cool-down applies (§7.2): the destination is unusable until usableAt, so a
    // compromised console cannot add an address and drain to it in one session.
    const { usableAt } = await engine.allowlist.add(
      tenant.id,
      id,
      allowChain,
      address,
      engine.allowlistCooldownMs,
    );
    await reply.status(201).send({ chain: allowChain, address, usableAt: usableAt.toISOString() });
  });

  /**
   * Remove a destination from the allow-list (§7.2).
   *
   * There was no way to withdraw an address once added: after its cool-down it was
   * usable forever. A tenant who discovers a destination is compromised needs this,
   * and needs it to take effect at once.
   */
  app.delete(
    "/v1/accounts/:id/allowlist",
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
    // Reject a malformed or wrong-chain destination before the intent is recorded,
    // a gather lease is taken, or funds are locked.
    assertValidDestination(
      withdrawChain,
      (req.body as { destination: string }).destination,
      engine.chains.familyOf(withdrawChain),
    );
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
  const adminService = new AdminService(
    engine.sql,
    engine,
    opts.admin?.limits ?? DEFAULT_LIMITS,
    opts.admin?.feeTreasuryAddressFor,
  );
  registerAdmin(app, { service: adminService, token: opts.admin?.token });

  // Tenant portal (dashboard) — static SPA shell; its data calls hit /v1 with the
  // tenant API key, so the shell itself needs no server-side auth.
  registerPortal(app);

  // Autonomous AI Agent Financial Ops & Anomaly Detection routes. Handed the same
  // `tenantOf` every other /v1 route uses, so authentication AND scope enforcement
  // are shared rather than reimplemented — the reimplementation checked no scope.
  registerAi(app, { engine, tenantOf });

  await app.ready();
  return app;
}
