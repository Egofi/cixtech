import type { BalanceTarget, PoolBalanceCache } from "@cixtech/attribution";
import type { AddressBalance } from "@cixtech/attribution";
import { Worker } from "bullmq";
import type IORedis from "ioredis";
import { QUEUE_POOL_BALANCE, connectionOpts } from "../queues.js";

/** How many addresses to read at once. Public RPC endpoints rate-limit well below this. */
const DEFAULT_CONCURRENCY = 4;

/**
 * Refreshes the cached on-chain balance of every pool address (build spec §8).
 *
 * The admin console shows a balance beside each pool address, and reading them
 * live is one RPC round trip per address per page load against an unbounded
 * pool — public endpoints rate-limit long before that is comfortable. This
 * observes them on a schedule instead, so the console renders instantly and
 * shows how old each number is.
 *
 * Deliberately read-only. Nothing here authorizes a transfer: the gather and the
 * reconciler both go to the chain themselves, because a cached balance is a
 * reporting convenience and must never become a money decision.
 */
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
      // A partial failure is normal (one chain's RPC down) and is not an error:
      // those rows keep their previous value with the reason attached, and the
      // console shows them ageing rather than pretending they are current.
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
