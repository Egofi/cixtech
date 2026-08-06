import type { SqlClient } from "@cixtech/ledger";
/** Posts a raw body to a tenant URL. Injected so tests record deliveries. */
export interface WebhookPoster {
    post(url: string, body: string, headers: Record<string, string>): Promise<{
        ok: boolean;
        status: number;
    }>;
}
export declare class FetchWebhookPoster implements WebhookPoster {
    post(url: string, body: string, headers: Record<string, string>): Promise<{
        ok: boolean;
        status: number;
    }>;
}
export interface WebhookEndpoint {
    url: string;
    secret: string;
}
export declare class WebhookEndpointStore {
    private readonly sql;
    constructor(sql: SqlClient);
    set(tenantId: string, url: string, secret: string): Promise<void>;
    get(tenantId: string): Promise<WebhookEndpoint | null>;
}
/** `sha256=<hmac>` over the exact bytes sent — the value of the x-cixtech-signature header. */
export declare function signWebhook(secret: string, body: string): string;
/** Constant-time signature check, for a receiver verifying a delivery. */
export declare function verifyWebhook(secret: string, body: string, signature: string): boolean;
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
export declare class WebhookOutbox {
    private readonly sql;
    constructor(sql: SqlClient);
    enqueue(tenantId: string, event: string, data: Record<string, unknown>): Promise<string>;
    /**
     * Atomically CLAIM due deliveries so two dispatchers (or overlapping ticks) never
     * both send the same row. `FOR UPDATE SKIP LOCKED` selects only unlocked due rows,
     * and the same transaction leases them by pushing `next_attempt` forward — so a
     * concurrent claimer skips them and, if this worker dies mid-delivery, the lease
     * expires and the row is retried (at-least-once; receivers dedupe on the body id).
     */
    claimDue(now: Date, limit: number, leaseMs?: number): Promise<DueDelivery[]>;
    markDelivered(id: string): Promise<void>;
    recordFailure(id: string, attempts: number, nextAttempt: Date, error: string, dead: boolean): Promise<void>;
}
export declare function backoffAt(now: Date, attempts: number): Date;
/**
 * Drains the webhook outbox (egofi's IPN pattern, at-least-once): claims due
 * deliveries, signs the stored body with the tenant's secret, POSTs it, and marks
 * it delivered — or retries with exponential backoff, dead-lettering after
 * MAX_ATTEMPTS. A tenant with no endpoint dead-letters immediately. The server
 * runs `dispatchDue` on an interval.
 */
export declare class WebhookDispatcher {
    private readonly outbox;
    private readonly endpoints;
    private readonly poster;
    constructor(outbox: WebhookOutbox, endpoints: WebhookEndpointStore, poster: WebhookPoster);
    dispatchDue(now?: Date, limit?: number): Promise<{
        delivered: number;
        failed: number;
    }>;
}
export {};
