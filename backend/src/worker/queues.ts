import { type ConnectionOptions, Queue } from "bullmq";
import IORedis from "ioredis";

// ── Queue names ──────────────────────────────────────────────────────────────

export const QUEUE_WEBHOOK_DISPATCH = "webhook-dispatch";
export const QUEUE_EXTERNAL_RECONCILE = "external-reconcile";
export const QUEUE_POOL_RELEASE = "pool-release";
export const QUEUE_POOL_BALANCE = "pool-balance";
/** Deposit detection — moved here from the API's setInterval so exactly one poller runs. */
export const QUEUE_DEPOSIT_DETECT = "deposit-detect";

export const ALL_QUEUES = [
  QUEUE_WEBHOOK_DISPATCH,
  QUEUE_EXTERNAL_RECONCILE,
  QUEUE_POOL_RELEASE,
  QUEUE_POOL_BALANCE,
  QUEUE_DEPOSIT_DETECT,
] as const;

// ── Redis connection ─────────────────────────────────────────────────────────

/**
 * Build a shared IORedis connection from the standard `REDIS_URL` env var.
 * BullMQ needs ioredis ≥ 5, so we create a properly configured instance.
 * `maxRetriesPerRequest: null` is required by BullMQ's worker to avoid
 * premature timeout errors on the blocking BRPOPLPUSH it runs.
 */
export function createRedisConnection(url: string): IORedis {
  return new IORedis(url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    retryStrategy: (times) => Math.min(times * 200, 5_000),
  });
}

/**
 * BullMQ accepts either an IORedis instance or a `ConnectionOptions` bag.
 * Workers and Queues on the same process share the connection to avoid
 * N × 6-fd overhead (each BullMQ primitive opens its own if given opts
 * instead of an instance).
 */
export function connectionOpts(redis: IORedis): { connection: ConnectionOptions } {
  return { connection: redis as unknown as ConnectionOptions };
}

// ── Queue factories ──────────────────────────────────────────────────────────

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

/**
 * Repeatable schedule helper. Removes any prior schedule for this name and
 * adds the new interval — so a deploy with a changed interval applies cleanly.
 */
export async function upsertRepeatable(
  queue: Queue,
  name: string,
  intervalMs: number,
): Promise<void> {
  // Remove stale schedules matching this job name, if any.
  const existing = await queue.getRepeatableJobs();
  for (const job of existing) {
    if (job.name === name) {
      await queue.removeRepeatableByKey(job.key);
    }
  }
  await queue.add(name, {}, { repeat: { every: intervalMs }, jobId: name });
}
