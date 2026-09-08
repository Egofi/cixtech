import type { SqlClient } from "@/ledger";
import {
  GATHER_STRATEGIES,
  type GatherStrategyKind,
  UnknownGatherStrategyError,
  assertStrategySupported,
} from "./gather-strategy.js";

/**
 * Which strategy NEW addresses are minted under, per `(chain, tenant?)` (ADR 0011).
 * A tenant row overrides the chain-wide row.
 *
 * The toggle is deliberately narrow: it decides minting only. Draining always
 * follows the tag recorded on each address, so flipping this is a **forward-only
 * cutover with a drain tail** — existing addresses keep working under the strategy
 * that created them until the pool rotates over.
 *
 * Flipping it is a fund-movement change, so it carries the same dual-control and
 * audit trail as a policy change (build spec §7): who changed it, who approved it.
 */
export const GATHER_CONFIG_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS gather_config (
  chain           text NOT NULL,
  tenant          text NOT NULL DEFAULT '',   -- '' = chain-wide default
  active_strategy text NOT NULL,
  updated_by      text NOT NULL,
  approved_by     text NOT NULL,
  effective_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain, tenant)
);
`;

const CHAIN_WIDE = "";

export interface GatherConfigRow {
  chain: string;
  /** Empty string for the chain-wide default. */
  tenant: string;
  activeStrategy: GatherStrategyKind;
  updatedBy: string;
  approvedBy: string;
  effectiveAt: Date;
}

/** Chain family, needed to reject a strategy a chain structurally cannot run. */
export type ChainFamilyLookup = (chain: string) => string | undefined;

export class GatherConfigStore {
  constructor(
    private readonly sql: SqlClient,
    /** Resolves a chain's family so 7702 can be rejected off-EVM (ADR 0011). */
    private readonly familyOf: ChainFamilyLookup = () => undefined,
  ) {}

  /**
   * The strategy new addresses mint under. Tenant override first, then the
   * chain-wide row, then `fallback` — never a silent guess at a different one.
   */
  async activeFor(
    chain: string,
    tenant: string,
    fallback: GatherStrategyKind = "EOA_FUND_TRANSFER",
  ): Promise<GatherStrategyKind> {
    const r = await this.sql.query<{ active_strategy: string; tenant: string }>(
      `SELECT active_strategy, tenant FROM gather_config
        WHERE chain = $1 AND tenant IN ($2, $3)
        ORDER BY tenant DESC LIMIT 1`,
      [chain, tenant, CHAIN_WIDE],
    );
    const found = r.rows[0]?.active_strategy;
    return (found as GatherStrategyKind | undefined) ?? fallback;
  }

  /**
   * Set the active strategy under dual control. `updatedBy` and `approvedBy` must
   * be distinct identities — the same separation of duties the policy engine
   * applies to a payout (§7.4), because this is a fund-movement change.
   */
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
    const r = await this.sql.query<{
      chain: string;
      tenant: string;
      active_strategy: string;
      updated_by: string;
      approved_by: string;
      effective_at: string;
    }>(
      `INSERT INTO gather_config (chain, tenant, active_strategy, updated_by, approved_by, effective_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (chain, tenant) DO UPDATE
         SET active_strategy = EXCLUDED.active_strategy,
             updated_by = EXCLUDED.updated_by,
             approved_by = EXCLUDED.approved_by,
             effective_at = EXCLUDED.effective_at
       RETURNING chain, tenant, active_strategy, updated_by, approved_by, effective_at`,
      [
        input.chain,
        tenant,
        input.strategy,
        input.updatedBy,
        input.approvedBy,
        new Date().toISOString(),
      ],
    );
    const row = r.rows[0];
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
    const r = await this.sql.query<{
      chain: string;
      tenant: string;
      active_strategy: string;
      updated_by: string;
      approved_by: string;
      effective_at: string;
    }>(
      "SELECT chain, tenant, active_strategy, updated_by, approved_by, effective_at FROM gather_config ORDER BY chain, tenant",
    );
    return r.rows.map((row) => ({
      chain: row.chain,
      tenant: row.tenant,
      activeStrategy: row.active_strategy as GatherStrategyKind,
      updatedBy: row.updated_by,
      approvedBy: row.approved_by,
      effectiveAt: new Date(row.effective_at),
    }));
  }
}
