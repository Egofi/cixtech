import { timingSafeEqual } from "node:crypto";
import { SYSTEM_ROUTES } from "@/common/routes";
import type { MetricsOptions } from "@/types";
import type { FastifyInstance } from "fastify";
import { Counter, Histogram, Registry, collectDefaultMetrics } from "prom-client";

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

  app.get(SYSTEM_ROUTES.METRICS, { schema: { hide: true } }, async (req, reply) => {
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
