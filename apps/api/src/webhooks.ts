import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
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

const MAX_ATTEMPTS = 8;
const BACKOFF_BASE_MS = 5_000;
const BACKOFF_MAX_MS = 60 * 60_000;

interface DueDelivery {
  id: string;
  tenantId: string;
  body: string;
  attempts: number;
}

/**
 * Transactional outbox for webhooks. `enqueue` records the EXACT body to send
 * (with its own id + fixed ts) so the signature is stable across retries and the
 * receiver can dedupe. The dispatcher drains it; nothing is delivered inline, so a
 * momentarily-down tenant endpoint loses no events.
 */
export class WebhookOutbox {
  constructor(private readonly sql: SqlClient) {}

  async enqueue(tenantId: string, event: string, data: Record<string, unknown>): Promise<string> {
    const id = randomUUID();
    const now = new Date();
    const body = JSON.stringify({ id, event, data, ts: now.toISOString() });
    // `next_attempt` is written from the APPLICATION clock, not the column's
    // `now()` default, because `claimDue` compares it against an application
    // clock. Postgres timestamps carry microseconds while a JS `Date` carries
    // milliseconds, so a server-generated default lands a few microseconds after
    // the same millisecond on this side and the row reads as not-yet-due. One
    // clock on both sides of the comparison removes the whole class of problem.
    await this.sql.query(
      "INSERT INTO webhook_delivery (id, tenant_id, body, next_attempt) VALUES ($1, $2, $3, $4)",
      [id, tenantId, body, now.toISOString()],
    );
    return id;
  }

  /**
   * Atomically CLAIM due deliveries so two dispatchers (or overlapping ticks) never
   * both send the same row. `FOR UPDATE SKIP LOCKED` selects only unlocked due rows,
   * and the same transaction leases them by pushing `next_attempt` forward — so a
   * concurrent claimer skips them and, if this worker dies mid-delivery, the lease
   * expires and the row is retried (at-least-once; receivers dedupe on the body id).
   */
  async claimDue(now: Date, limit: number, leaseMs = 60_000): Promise<DueDelivery[]> {
    return this.sql.transaction(async (tx) => {
      const r = await tx.query<{
        id: string;
        tenant_id: string;
        body: string;
        attempts: number;
      }>(
        `SELECT id, tenant_id, body, attempts FROM webhook_delivery
         WHERE status = 'pending' AND next_attempt <= $1
         ORDER BY next_attempt LIMIT $2
         FOR UPDATE SKIP LOCKED`,
        [now.toISOString(), limit],
      );
      if (r.rows.length > 0) {
        const lease = new Date(now.getTime() + leaseMs).toISOString();
        await tx.query("UPDATE webhook_delivery SET next_attempt = $2 WHERE id = ANY($1::text[])", [
          r.rows.map((row) => row.id),
          lease,
        ]);
      }
      return r.rows.map((row) => ({
        id: row.id,
        tenantId: row.tenant_id,
        body: row.body,
        attempts: Number(row.attempts),
      }));
    });
  }

  async markDelivered(id: string): Promise<void> {
    await this.sql.query("UPDATE webhook_delivery SET status = 'delivered' WHERE id = $1", [id]);
  }

  async recordFailure(
    id: string,
    attempts: number,
    nextAttempt: Date,
    error: string,
    dead: boolean,
  ): Promise<void> {
    await this.sql.query(
      `UPDATE webhook_delivery
       SET attempts = $2, next_attempt = $3, last_error = $4, status = $5
       WHERE id = $1`,
      [id, attempts, nextAttempt.toISOString(), error.slice(0, 500), dead ? "dead" : "pending"],
    );
  }
}

export function backoffAt(now: Date, attempts: number): Date {
  const delay = Math.min(BACKOFF_BASE_MS * 2 ** (attempts - 1), BACKOFF_MAX_MS);
  return new Date(now.getTime() + delay);
}

/**
 * Drains the webhook outbox (egofi's IPN pattern, at-least-once): claims due
 * deliveries, signs the stored body with the tenant's secret, POSTs it, and marks
 * it delivered — or retries with exponential backoff, dead-lettering after
 * MAX_ATTEMPTS. A tenant with no endpoint dead-letters immediately. The server
 * runs `dispatchDue` on an interval.
 */
export class WebhookDispatcher {
  constructor(
    private readonly outbox: WebhookOutbox,
    private readonly endpoints: WebhookEndpointStore,
    private readonly poster: WebhookPoster,
  ) {}

  async dispatchDue(
    now: Date = new Date(),
    limit = 50,
  ): Promise<{ delivered: number; failed: number }> {
    const due = await this.outbox.claimDue(now, limit);
    let delivered = 0;
    let failed = 0;

    for (const row of due) {
      const endpoint = await this.endpoints.get(row.tenantId);
      const attempts = row.attempts + 1;
      if (!endpoint) {
        await this.outbox.recordFailure(row.id, attempts, now, "no webhook endpoint", true);
        failed++;
        continue;
      }
      try {
        const res = await this.poster.post(endpoint.url, row.body, {
          "x-cixtech-signature": signWebhook(endpoint.secret, row.body),
        });
        if (!res.ok) throw new Error(`endpoint returned ${res.status}`);
        await this.outbox.markDelivered(row.id);
        delivered++;
      } catch (err) {
        failed++;
        const dead = attempts >= MAX_ATTEMPTS;
        await this.outbox.recordFailure(
          row.id,
          attempts,
          backoffAt(now, attempts),
          String(err),
          dead,
        );
      }
    }
    return { delivered, failed };
  }
}
