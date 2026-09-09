import { Worker } from "bullmq";
import type IORedis from "ioredis";
import { QUEUE_DEPOSIT_DETECT, connectionOpts } from "../queues.js";

export interface DepositWatcherFn {
  pollAll(chains: string[]): Promise<{ credited: number; failures: string[] }>;
}

export function startDetectionWorker(
  redis: IORedis,
  watcher: DepositWatcherFn,
  chains: string[],
  log: (msg: string, data?: Record<string, unknown>) => void,
  logError: (msg: string, data?: Record<string, unknown>) => void,
): Worker {
  const worker = new Worker(
    QUEUE_DEPOSIT_DETECT,
    async () => {
      const result = await watcher.pollAll(chains);

      for (const failure of result.failures) {
        logError("detection poll failed", { detail: failure });
      }
      if (result.credited > 0) log("deposits credited", { credited: result.credited });
    },
    {
      ...connectionOpts(redis),

      concurrency: 1,
    },
  );

  worker.on("failed", (_job, err) => {
    logError("detection job failed", { error: err.message });
  });

  return worker;
}
