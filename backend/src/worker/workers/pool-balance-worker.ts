import type { PoolBalanceCache } from "@/attribution";
import type { AddressBalance } from "@/attribution";
import type { BalanceTarget } from "@/types";
import { Worker } from "bullmq";
import type IORedis from "ioredis";
import { QUEUE_POOL_BALANCE, connectionOpts } from "../queues.js";

const DEFAULT_CONCURRENCY = 4;

export function startPoolBalanceWorker(
  redis: IORedis,
  cache: PoolBalanceCache,
  balances: AddressBalance,
  assetsForChain: (chain: string) => readonly string[],
  log: (msg: string, data?: Record<string, unknown>) => void,
  concurrency = DEFAULT_CONCURRENCY,
): Worker {
  const worker = new Worker(
    QUEUE_POOL_BALANCE,
    async () => {
      const targets: BalanceTarget[] = await cache.targets(assetsForChain);
      if (targets.length === 0) {
        log("pool balance refresh", { targets: 0 });
        return;
      }
      const summary = await cache.refresh(targets, balances, { concurrency });

      log("pool balance refresh", {
        targets: targets.length,
        observed: summary.observed,
        failed: summary.failed,
      });
    },
    { ...connectionOpts(redis), concurrency: 1 },
  );

  worker.on("failed", (_job, err) => {
    log("pool balance job failed", { error: err.message });
  });

  return worker;
}
