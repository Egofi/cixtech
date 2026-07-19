import type { FastifyInstance } from "fastify";
import { Counter, Histogram, Registry, collectDefaultMetrics } from "prom-client";

/**
 * Prometheus metrics on a PER-APP registry (so repeated buildApp() in tests never
 * double-registers a global metric), scraped at GET /metrics. Records request
 * count and latency labelled by method, route PATTERN (not the raw URL, to keep
 * cardinality bounded), and status.
 */
export function installMetrics(app: FastifyInstance): void {
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

  app.get("/metrics", { schema: { hide: true } }, async (_req, reply) => {
    await reply.header("content-type", registry.contentType).send(await registry.metrics());
  });
}
