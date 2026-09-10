import type { ExternalReconciler } from "@/chains";
import type { ExternalDriftRow } from "@/types";
import { Worker } from "bullmq";
import type IORedis from "ioredis";
import { QUEUE_EXTERNAL_RECONCILE, connectionOpts } from "../queues.js";

export function startReconcilerWorker(
  redis: IORedis,
  reconciler: ExternalReconciler,
  log: (msg: string, data?: Record<string, unknown>) => void,
): Worker {
  const worker = new Worker(
    QUEUE_EXTERNAL_RECONCILE,
    async () => {
      const result = await reconciler.run();
      if (result.drift.length > 0) {
        log("RECONCILIATION DRIFT DETECTED", {
          driftCount: result.drift.length,
          tripped: result.tripped,
          drift: result.drift.map((d: ExternalDriftRow) => ({
            chain: d.chain,
            merchant: d.merchant,
            asset: d.asset,
            ledger: d.ledger.toString(),
            onChain: d.onChain.toString(),
          })),
        });
      } else {
        log("reconciliation pass", { groups: "all balanced" });
      }
    },
    {
      ...connectionOpts(redis),
      concurrency: 1,
    },
  );

  worker.on("failed", (_job, err) => {
    log("reconciler job failed", { error: err.message });
  });

  return worker;
}
