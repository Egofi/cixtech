import type { FastifyInstance, FastifyReply } from "fastify";
import { PORTAL_CSS, PORTAL_HTML, PORTAL_JS } from "./ui.js";

const hidden = { schema: { hide: true } } as const;

/**
 * Serve the tenant portal SPA (dashboard). The shell is static and public; every
 * data call it makes hits the normal `/v1` surface with the tenant's API key, so
 * the portal grants nothing the API would not — same posture as the admin console
 * (ADR 0015), same zero-build inline delivery.
 */
export function registerPortal(app: FastifyInstance): void {
  const asset =
    (type: string, body: string) =>
    async (_req: unknown, reply: FastifyReply): Promise<FastifyReply> =>
      reply.header("content-type", type).send(body);

  app.get("/portal", hidden, asset("text/html; charset=utf-8", PORTAL_HTML));
  app.get("/portal/app.js", hidden, asset("application/javascript; charset=utf-8", PORTAL_JS));
  app.get("/portal/styles.css", hidden, asset("text/css; charset=utf-8", PORTAL_CSS));
}
