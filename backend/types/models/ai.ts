export interface FinancialAiQueryRequest {
  tenantId: string;
  prompt: string;
}

export interface FinancialAiQueryResponse {
  answer: string;
  intent: "BALANCE_INQUIRY" | "TRANSACTION_HISTORY" | "FEE_ANALYSIS" | "SOLVENCY_CHECK" | "UNKNOWN";
  data?: unknown;
  confidenceScore: number;
}

export type AgentRuleCondition = "BALANCE_BELOW" | "VELOCITY_ABOVE" | "ANOMALY_TRIGGERED";

export type AgentRuleAction =
  | "NOTIFY"
  | "PAUSE_WITHDRAWALS"
  | "AUTO_REBALANCE"
  | "REQUIRE_APPROVAL";

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

export type AnomalyType = "VELOCITY_SPIKE" | "ZERO_DAY_ADDRESS_DRAIN";

export type AnomalySeverity = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export interface AnomalyAlert {
  id: string;
  tenantId: string;
  type: AnomalyType;
  severity: AnomalySeverity;
  description: string;
  context: Record<string, unknown>;
  detectedAt: Date;
}
