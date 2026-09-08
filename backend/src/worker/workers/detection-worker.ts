import { Worker } from "bullmq";
import type IORedis from "ioredis";
import { QUEUE_DEPOSIT_DETECT, connectionOpts } from "../queues.js";

/**
 * Polls each configured chain for inbound deposits and credits the ones that have
 * reached finality. Matches `Engine.watcher` in the API.
 */
export interface DepositWatcherFn {
  /** Per-chain failures come back as `"<CHAIN>: <message>"`, already isolated. */
  pollAll(chains: string[]): Promise<{ credited: number; failures: string[] }>;
}

/**
 * BullMQ worker for deposit detection.
 *
 * This used to be a `setInterval` in the API's `server.ts`, which made the API
 * un-scalable in a way that was easy to miss: each replica ran its own poller, so
 * a second replica doubled the RPC load against every chain and had both instances
 * racing to ingest the same deposits. Ingest is idempotent — the ledger dedupes on
 * `{chain}:{txId}:{index}` — so it was never a double-credit, but it was wasted
 * upstream quota and contention that grew linearly with replica count.
 *
 * As a queue job there is exactly one poller regardless of how many API or worker
 * replicas run, because BullMQ's repeatable job is keyed by name and the lock is
 * held for the duration of a run.
 *
 * `concurrency: 1` is load-bearing for the same reason: overlapping runs against a
 * slow RPC endpoint would reintroduce precisely the racing this move eliminates.
 */
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

      // `pollAll` already isolates per-chain failures: one unreachable RPC
      // endpoint fails its own tick and is reported, but never stops the other
      // chains being polled — and never fails the JOB, which would back detection
      // off for every chain at once because of one bad endpoint.
      for (const failure of result.failures) {
        logError("detection poll failed", { detail: failure });
      }
      if (result.credited > 0) log("deposits credited", { credited: result.credited });
    },
    {
      ...connectionOpts(redis),
      // One poller. See the note above — this is the property the move exists for.
      concurrency: 1,
    },
  );

  worker.on("failed", (_job, err) => {
    logError("detection job failed", { error: err.message });
  });

  return worker;
}
