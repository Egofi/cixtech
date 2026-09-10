import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { kyselyFor } from "@/postgres";
import { webhookDelivery, webhookEndpoint } from "@/queries";
import type { SqlClient, WebhookEndpoint } from "@/types";

export interface WebhookPoster {
  post(
    url: string,
    body: string,
    headers: Record<string, string>,
  ): Promise<{ ok: boolean; status: number }>;
}

export class FetchWebhookPoster implements WebhookPoster {
  constructor(
    private readonly assertAllowed?: (url: string) => Promise<void>,
    private readonly timeoutMs = 10_000,
  ) {}

  async post(url: string, body: string, headers: Record<string, string>) {
    await this.assertAllowed?.(url);
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (res.status >= 300 && res.status < 400) {
      throw new Error(`endpoint redirected (${res.status}); webhook targets must not redirect`);
    }
    return { ok: res.ok, status: res.status };
  }
}

export class WebhookEndpointStore {
  constructor(private readonly sql: SqlClient) {}

  async set(tenantId: string, url: string, secret: string): Promise<void> {
    await webhookEndpoint.upsert(kyselyFor(this.sql), tenantId, url, secret).execute();
  }

  async get(tenantId: string): Promise<WebhookEndpoint | null> {
    const row = await webhookEndpoint
      .withSecretFor(kyselyFor(this.sql), tenantId)
      .executeTakeFirst();
    return row ?? null;
  }
}

export function signWebhook(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

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

export class WebhookOutbox {
  constructor(private readonly sql: SqlClient) {}

  async enqueue(tenantId: string, event: string, data: Record<string, unknown>): Promise<string> {
    const id = randomUUID();
    const now = new Date();
    const body = JSON.stringify({ id, event, data, ts: now.toISOString() });
    await webhookDelivery
      .enqueue(kyselyFor(this.sql), { id, tenant_id: tenantId, body, next_attempt: now })
      .execute();
    return id;
  }

  async claimDue(now: Date, limit: number, leaseMs = 60_000): Promise<DueDelivery[]> {
    return this.sql.transaction(async (tx) => {
      const db = kyselyFor(tx);
      const r = await webhookDelivery.claimDue(db, now, limit);
      if (r.rows.length > 0) {
        const lease = new Date(now.getTime() + leaseMs);
        await webhookDelivery
          .extendLease(
            db,
            r.rows.map((row) => row.id),
            lease,
          )
          .execute();
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
    await webhookDelivery.markDelivered(kyselyFor(this.sql), id).execute();
  }

  async recordFailure(
    id: string,
    attempts: number,
    nextAttempt: Date,
    error: string,
    dead: boolean,
  ): Promise<void> {
    await webhookDelivery
      .recordFailure(kyselyFor(this.sql), id, attempts, nextAttempt, error.slice(0, 500), dead)
      .execute();
  }
}

export function backoffAt(now: Date, attempts: number): Date {
  const delay = Math.min(BACKOFF_BASE_MS * 2 ** (attempts - 1), BACKOFF_MAX_MS);
  return new Date(now.getTime() + delay);
}

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
