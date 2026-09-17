import { kyselyFor } from "@/postgres";
import { agentRule, aiBalances } from "@/queries";
import type { AgentRuleAction, AgentRuleCondition, RuleEvaluationResult, SqlClient } from "@/types";
import { normalTotalsByAsset } from "./balances.js";

export class AgenticRulesEngine {
  constructor(private readonly sql: SqlClient) {}

  async evaluateRules(tenantId: string): Promise<RuleEvaluationResult[]> {
    const results: RuleEvaluationResult[] = [];
    const now = new Date();

    const rows = await agentRule.activeFor(kyselyFor(this.sql), tenantId).execute();

    for (const r of rows) {
      let triggered = false;
      let reason = `Condition ${r.condition_type} evaluated cleanly`;

      if (r.condition_type === "BALANCE_BELOW") {
        // Evaluated per asset. The previous version summed every asset's base
        // units into one figure and compared that to the threshold, which is
        // not a balance in any asset — and it matched accounts by an unanchored
        // LIKE on the tenant id rather than the tenant's own accounts.
        const balRows = await aiBalances
          .forTenantMerchants(kyselyFor(this.sql), tenantId)
          .execute();
        const threshold = BigInt(r.condition_threshold);
        const totals = normalTotalsByAsset(balRows);

        const breached = [...totals.entries()]
          .filter(([, amount]) => amount < threshold)
          .sort(([a], [b]) => a.localeCompare(b));

        if (breached.length > 0) {
          triggered = true;
          const which = breached.map(([asset, amount]) => `${asset} ${amount}`).join(", ");
          reason = `Below the configured threshold (${threshold}) for: ${which}`;
        } else if (totals.size === 0) {
          reason = "No balances recorded for this tenant, so BALANCE_BELOW did not evaluate";
        }
      }

      results.push({
        ruleId: r.id,
        ruleName: r.name,
        triggered,
        action: r.action as AgentRuleAction,
        reason,
        evaluatedAt: now,
      });
    }

    return results;
  }
}
