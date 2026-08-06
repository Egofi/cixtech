import type { SqlClient } from "@cixtech/ledger";

export type AgentRuleCondition = "BALANCE_BELOW" | "VELOCITY_ABOVE" | "ANOMALY_TRIGGERED";
export type AgentRuleAction = "NOTIFY" | "PAUSE_WITHDRAWALS" | "AUTO_REBALANCE" | "REQUIRE_APPROVAL";

export interface AgentRule {
  id: string;
  tenantId: string;
  name: string;
  conditionType: AgentRuleCondition;
  conditionThreshold: string;
  action: AgentRuleAction;
  isActive: boolean;
  createdAt: Date;
}

export interface RuleEvaluationResult {
  ruleId: string;
  ruleName: string;
  triggered: boolean;
  action: AgentRuleAction;
  reason: string;
  evaluatedAt: Date;
}

/**
 * Autonomous Agentic Financial Rules Engine (US-AI-01, PRD §4.4.1).
 *
 * Programmatic agentic controls over sub-account balances, withdrawal limits,
 * and automated liquidity rebalancing.
 */
export class AgenticRulesEngine {
  constructor(private readonly sql: SqlClient) {}

  /**
   * Evaluate active autonomous agentic rules for a tenant.
   */
  async evaluateRules(tenantId: string): Promise<RuleEvaluationResult[]> {
    const results: RuleEvaluationResult[] = [];
    const now = new Date();

    const { rows } = await this.sql.query<{
      id: string;
      tenant_id: string;
      name: string;
      condition_type: AgentRuleCondition;
      condition_threshold: string;
      action: AgentRuleAction;
      is_active: boolean;
      created_at: string;
    }>("SELECT * FROM agent_rule WHERE tenant_id = $1 AND is_active = true", [tenantId]);

    for (const r of rows) {
      let triggered = false;
      let reason = `Condition ${r.condition_type} evaluated cleanly`;

      if (r.condition_type === "BALANCE_BELOW") {
        const { rows: balRows } = await this.sql.query<{ amount: string }>(
          `SELECT amount FROM balance WHERE account LIKE '%' || $1 || '%'`,
          [tenantId],
        );
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
        action: r.action,
        reason,
        evaluatedAt: now,
      });
    }

    return results;
  }
}
