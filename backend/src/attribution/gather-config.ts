import { UnknownGatherStrategyError } from "@/common";
import { kyselyFor } from "@/postgres";
import { gatherConfig } from "@/queries";
import type { GatherConfigRow, GatherStrategyKind, SqlClient } from "@/types";

import { GATHER_STRATEGIES, assertStrategySupported } from "./gather-strategy.js";

const CHAIN_WIDE = "";

export type ChainFamilyLookup = (chain: string) => string | undefined;

export class GatherConfigStore {
  constructor(
    private readonly sql: SqlClient,

    private readonly familyOf: ChainFamilyLookup = () => undefined,
  ) {}

  async activeFor(
    chain: string,
    tenant: string,
    fallback: GatherStrategyKind = "EOA_FUND_TRANSFER",
  ): Promise<GatherStrategyKind> {
    const row = await gatherConfig
      .activeStrategy(kyselyFor(this.sql), chain, tenant, CHAIN_WIDE)
      .executeTakeFirst();
    const found = row?.active_strategy;
    return (found as GatherStrategyKind | undefined) ?? fallback;
  }

  async setActive(input: {
    chain: string;
    tenant?: string;
    strategy: GatherStrategyKind;
    updatedBy: string;
    approvedBy: string;
  }): Promise<GatherConfigRow> {
    if (!GATHER_STRATEGIES.includes(input.strategy)) {
      throw new UnknownGatherStrategyError(`Unknown gather strategy ${input.strategy}`, {
        context: { strategy: input.strategy },
        exposable: true,
      });
    }
    if (!input.updatedBy || input.updatedBy === input.approvedBy) {
      throw new UnknownGatherStrategyError(
        "Changing the gather strategy needs two distinct identities (requester ≠ approver)",
        { context: { updatedBy: input.updatedBy }, exposable: true },
      );
    }
    const family = this.familyOf(input.chain);
    if (family) assertStrategySupported(input.chain, input.strategy, family);

    const tenant = input.tenant ?? CHAIN_WIDE;
    const rows = await gatherConfig
      .upsert(kyselyFor(this.sql), {
        chain: input.chain,
        tenant,
        active_strategy: input.strategy,
        updated_by: input.updatedBy,
        approved_by: input.approvedBy,
        effective_at: new Date(),
      })
      .execute();
    const row = rows[0];
    if (!row) throw new Error("gather_config upsert returned no row");
    return {
      chain: row.chain,
      tenant: row.tenant,
      activeStrategy: row.active_strategy as GatherStrategyKind,
      updatedBy: row.updated_by,
      approvedBy: row.approved_by,
      effectiveAt: new Date(row.effective_at),
    };
  }

  async list(): Promise<GatherConfigRow[]> {
    const rows = await gatherConfig.all(kyselyFor(this.sql)).execute();
    return rows.map((row) => ({
      chain: row.chain,
      tenant: row.tenant,
      activeStrategy: row.active_strategy as GatherStrategyKind,
      updatedBy: row.updated_by,
      approvedBy: row.approved_by,
      effectiveAt: new Date(row.effective_at),
    }));
  }
}
