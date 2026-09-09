import { Worker } from "bullmq";
import type IORedis from "ioredis";
import { QUEUE_POOL_RELEASE, connectionOpts } from "../queues.js";

export interface PoolReleaseFn {
  releaseCooledAddresses(now?: Date): Promise<number>;
}

export function startPoolReleaseWorker(
  redis: IORedis,
  pool: PoolReleaseFn,
  log: (msg: string, data?: Record<string, unknown>) => void,
): Worker {
  const worker = new Worker(
    QUEUE_POOL_RELEASE,
    async () => {
      const released = await pool.releaseCooledAddresses(new Date());
      if (released > 0) {
        log("pool addresses returned to AVAILABLE", { released });
      }
    },
    {
      ...connectionOpts(redis),
      concurrency: 1,
    },
  );

  worker.on("failed", (_job, err) => {
    log("pool release job failed", { error: err.message });
  });

  return worker;
}
