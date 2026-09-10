import { kyselyFor } from "@/postgres";
import { agentRule, aiBalances } from "@/queries";
import type { AgentRuleAction, AgentRuleCondition, RuleEvaluationResult, SqlClient } from "@/types";

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
        const balRows = await aiBalances.matchingAccount(kyselyFor(this.sql), tenantId).execute();
        const currentBal = balRows.reduce((acc, b) => acc + BigInt(b.amount), 0n);
        const threshold = BigInt(r.condition_threshold);

        if (currentBal < threshold) {
          triggered = true;
          reason = `Current balance (${currentBal}) is below configured threshold (${threshold})`;
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
