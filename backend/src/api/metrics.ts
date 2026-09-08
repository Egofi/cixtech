import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { Counter, Histogram, Registry, collectDefaultMetrics } from "prom-client";

/**
 * Prometheus metrics on a PER-APP registry (so repeated buildApp() in tests never
 * double-registers a global metric), scraped at GET /metrics. Records request
 * count and latency labelled by method, route PATTERN (not the raw URL, to keep
 * cardinality bounded), and status.
 */
export interface MetricsOptions {
  /**
   * Bearer token required to scrape. When set, `/metrics` answers 401 without it.
   *
   * The endpoint publishes the Node version, process start time, heap and
   * event-loop detail, and per-route request counts labelled by status — enough
   * to fingerprint the deployment and profile tenant activity from outside. It
   * was public.
   */
  token?: string | undefined;
}

export function installMetrics(app: FastifyInstance, opts: MetricsOptions = {}): void {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry });

  const total = new Counter({
    name: "http_requests_total",
    help: "Total HTTP requests",
    labelNames: ["method", "route", "status"],
    registers: [registry],
  });
  const duration = new Histogram({
    name: "http_request_duration_seconds",
    help: "HTTP request duration in seconds",
    labelNames: ["method", "route", "status"],
    registers: [registry],
  });

  app.addHook("onResponse", async (req, reply) => {
    const route = req.routeOptions?.url ?? req.url;
    const labels = { method: req.method, route, status: String(reply.statusCode) };
    total.inc(labels);
    duration.observe(labels, reply.elapsedTime / 1000);
  });

  app.get("/metrics", { schema: { hide: true } }, async (req, reply) => {
    if (opts.token) {
      const h = req.headers.authorization;
      const provided = typeof h === "string" && h.startsWith("Bearer ") ? h.slice(7) : "";
      const a = Buffer.from(provided);
      const b = Buffer.from(opts.token);
      if (a.length !== b.length || !timingSafeEqual(a, b)) {
        await reply
          .status(401)
          .send({ error: { code: "UNAUTHORIZED", message: "Metrics require the admin token" } });
        return reply;
      }
    }
    await reply.header("content-type", registry.contentType).send(await registry.metrics());
    return reply;
  });
}
