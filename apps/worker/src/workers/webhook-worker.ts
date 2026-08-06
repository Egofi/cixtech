import { Worker } from "bullmq";
import type IORedis from "ioredis";
import { QUEUE_WEBHOOK_DISPATCH, connectionOpts } from "../queues.js";

/**
 * The webhook dispatch interface — what the worker calls on each tick. This
 * mirrors `WebhookDispatcher.dispatchDue()` from the API package. The worker
 * constructs a `WebhookDispatcher` instance from the shared stores (SqlClient)
 * and passes it here.
 */
export interface WebhookDispatchFn {
  dispatchDue(now?: Date): Promise<{ delivered: number; failed: number }>;
}

/**
 * BullMQ worker for webhook dispatch (US-DEV-01, build spec §8).
 *
 * Replaces the `setInterval` loop in `server.ts` with a durable, observable
 * repeatable job. The actual dispatch logic is unchanged — `dispatchDue()` claims
 * due rows from the SQL outbox with `FOR UPDATE SKIP LOCKED` and delivers them.
 *
 * Concurrency is 1: the outbox's row-level locking prevents double-dispatch, but
 * serial processing avoids thundering-herd pressure on tenant endpoints.
 */
export function startWebhookWorker(
  redis: IORedis,
  dispatcher: WebhookDispatchFn,
  log: (msg: string, data?: Record<string, unknown>) => void,
): Worker {
  const worker = new Worker(
    QUEUE_WEBHOOK_DISPATCH,
    async () => {
      const now = new Date();
      const { delivered, failed } = await dispatcher.dispatchDue(now);
      if (delivered > 0 || failed > 0) {
        log("webhook dispatch tick", { delivered, failed });
      }
    },
    {
      ...connectionOpts(redis),
      concurrency: 1,
    },
  );

  worker.on("failed", (_job, err) => {
    log("webhook dispatch job failed", { error: err.message });
  });

  return worker;
}
