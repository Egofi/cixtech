import { Worker } from "bullmq";
import type IORedis from "ioredis";
import { QUEUE_FEE_SWEEP, connectionOpts } from "../queues.js";
import type { FeeSweepService } from "@cixtech/chains";

/** Assets to sweep on each cycle. Extend when new stablecoins are supported. */
const SWEEP_ASSETS = ["USDT", "USDC"] as const;

/**
 * BullMQ worker for automated fee-sweep (build spec §8).
 *
 * Periodically sweeps accrued platform fee revenue from merchant pool addresses
 * into the platform treasury. Each tick iterates all supported assets and sweeps
 * whatever has accumulated since the last run.
 *
 * The on-demand admin endpoint (`POST /admin/api/earnings/sweep`) remains
 * available for manual triggers — this worker automates the routine cycle.
 */
export function startFeeSweepWorker(
  redis: IORedis,
  sweeper: FeeSweepService,
  log: (msg: string, data?: Record<string, unknown>) => void,
): Worker {
  const worker = new Worker(
    QUEUE_FEE_SWEEP,
    async () => {
      for (const asset of SWEEP_ASSETS) {
        const result = await sweeper.sweep(asset);
        if (result.sweptCount > 0) {
          log("fee sweep completed", {
            asset,
            sweptCount: result.sweptCount,
            totalSweptAmount: result.totalSweptAmount,
          });
        }
      }
    },
    {
      ...connectionOpts(redis),
      concurrency: 1,
    },
  );

  worker.on("failed", (_job, err) => {
    log("fee sweep job failed", { error: err.message });
  });

  return worker;
}
