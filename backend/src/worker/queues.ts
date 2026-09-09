import { type ConnectionOptions, Queue } from "bullmq";
import IORedis from "ioredis";

export const QUEUE_WEBHOOK_DISPATCH = "webhook-dispatch";
export const QUEUE_EXTERNAL_RECONCILE = "external-reconcile";
export const QUEUE_POOL_RELEASE = "pool-release";
export const QUEUE_POOL_BALANCE = "pool-balance";

export const QUEUE_DEPOSIT_DETECT = "deposit-detect";

export const ALL_QUEUES = [
  QUEUE_WEBHOOK_DISPATCH,
  QUEUE_EXTERNAL_RECONCILE,
  QUEUE_POOL_RELEASE,
  QUEUE_POOL_BALANCE,
  QUEUE_DEPOSIT_DETECT,
] as const;

export function createRedisConnection(url: string): IORedis {
  return new IORedis(url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    retryStrategy: (times) => Math.min(times * 200, 5_000),
  });
}

export function connectionOpts(redis: IORedis): { connection: ConnectionOptions } {
  return { connection: redis as unknown as ConnectionOptions };
}

export function createQueues(redis: IORedis) {
  const opts = connectionOpts(redis);
  return {
    webhookDispatch: new Queue(QUEUE_WEBHOOK_DISPATCH, opts),
    externalReconcile: new Queue(QUEUE_EXTERNAL_RECONCILE, opts),
    poolRelease: new Queue(QUEUE_POOL_RELEASE, opts),
    poolBalance: new Queue(QUEUE_POOL_BALANCE, opts),
    depositDetect: new Queue(QUEUE_DEPOSIT_DETECT, opts),
  };
}

export async function upsertRepeatable(
  queue: Queue,
  name: string,
  intervalMs: number,
): Promise<void> {
  const existing = await queue.getRepeatableJobs();
  for (const job of existing) {
    if (job.name === name) {
      await queue.removeRepeatableByKey(job.key);
    }
  }
  await queue.add(name, {}, { repeat: { every: intervalMs }, jobId: name });
}
