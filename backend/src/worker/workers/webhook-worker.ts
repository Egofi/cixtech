import { Worker } from "bullmq";
import type IORedis from "ioredis";
import { QUEUE_WEBHOOK_DISPATCH, connectionOpts } from "../queues.js";

export interface WebhookDispatchFn {
  dispatchDue(now?: Date): Promise<{ delivered: number; failed: number }>;
}

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
