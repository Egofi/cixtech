import { GatherBusyError } from "@/common";
import { kyselyFor } from "@/postgres";
import { gatherLease as gatherLeaseQ } from "@/queries";
import type { SqlClient } from "@/types";

const DEFAULT_TTL_MS = 120_000;

export class GatherLease {
  constructor(
    private readonly sql: SqlClient,
    private readonly ttlMs: number = DEFAULT_TTL_MS,
  ) {}

  private static key(tenant: string, merchant: string, chain: string): string {
    return `${tenant}:${merchant}:${chain.toUpperCase()}`;
  }

  async acquire(
    tenant: string,
    merchant: string,
    chain: string,
    holder: string,
    now: Date = new Date(),
  ): Promise<boolean> {
    const expires = new Date(now.getTime() + this.ttlMs);
    const { rows } = await gatherLeaseQ.acquire(
      kyselyFor(this.sql),
      GatherLease.key(tenant, merchant, chain),
      holder,
      now,
      expires,
    );
    return rows.length > 0;
  }

  async release(tenant: string, merchant: string, chain: string, holder: string): Promise<void> {
    await gatherLeaseQ
      .release(kyselyFor(this.sql), GatherLease.key(tenant, merchant, chain), holder)
      .execute();
  }

  async withLease<T>(
    tenant: string,
    merchant: string,
    chain: string,
    holder: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const got = await this.acquire(tenant, merchant, chain, holder);
    if (!got) {
      throw new GatherBusyError(
        `Another operation is already spending ${merchant}'s ${chain} pool addresses. Retry shortly.`,
      );
    }
    try {
      return await fn();
    } finally {
      await this.release(tenant, merchant, chain, holder);
    }
  }
}
