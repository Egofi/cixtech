import { createHmac, timingSafeEqual } from "node:crypto";
import type { SqlClient } from "@cixtech/ledger";

/** Posts a raw body to a tenant URL. Injected so tests record deliveries. */
export interface WebhookPoster {
  post(
    url: string,
    body: string,
    headers: Record<string, string>,
  ): Promise<{ ok: boolean; status: number }>;
}

export class FetchWebhookPoster implements WebhookPoster {
  async post(url: string, body: string, headers: Record<string, string>) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    return { ok: res.ok, status: res.status };
  }
}

export interface WebhookEndpoint {
  url: string;
  secret: string;
}

export class WebhookEndpointStore {
  constructor(private readonly sql: SqlClient) {}

  async set(tenantId: string, url: string, secret: string): Promise<void> {
    await this.sql.query(
      `INSERT INTO webhook_endpoint (tenant_id, url, secret) VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id) DO UPDATE SET url = EXCLUDED.url, secret = EXCLUDED.secret`,
      [tenantId, url, secret],
    );
  }

  async get(tenantId: string): Promise<WebhookEndpoint | null> {
    const r = await this.sql.query<{ url: string; secret: string }>(
      "SELECT url, secret FROM webhook_endpoint WHERE tenant_id = $1",
      [tenantId],
    );
    return r.rows[0] ?? null;
  }
}

/** `sha256=<hmac>` over the exact bytes sent — the value of the x-cixtech-signature header. */
export function signWebhook(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

/** Constant-time signature check, for a receiver verifying a delivery. */
export function verifyWebhook(secret: string, body: string, signature: string): boolean {
  const expected = signWebhook(secret, body);
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Delivers a signed event to a tenant's webhook endpoint (egofi's IPN pattern):
 * HMAC-SHA256 over the exact JSON body, in `x-cixtech-signature`. A tenant with no
 * endpoint configured is simply not delivered to. (At-least-once retry via a
 * transactional outbox is the next step — this delivers once, best-effort.)
 */
export class WebhookDeliverer {
  constructor(
    private readonly store: WebhookEndpointStore,
    private readonly poster: WebhookPoster,
  ) {}

  async deliver(
    tenantId: string,
    event: string,
    data: Record<string, unknown>,
  ): Promise<{ delivered: boolean }> {
    const endpoint = await this.store.get(tenantId);
    if (!endpoint) return { delivered: false };
    const body = JSON.stringify({ event, data, ts: new Date().toISOString() });
    const res = await this.poster.post(endpoint.url, body, {
      "x-cixtech-signature": signWebhook(endpoint.secret, body),
    });
    return { delivered: res.ok };
  }
}
