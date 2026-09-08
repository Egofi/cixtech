/**
 * AI Financial Ops & Agentic Rules schema (Phase 4, PRD §4.4).
 */
export const AI_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS agent_rule (
  id                  text PRIMARY KEY,
  tenant_id           text NOT NULL REFERENCES tenant(id),
  name                text NOT NULL,
  condition_type      text NOT NULL,
  condition_threshold text NOT NULL,
  action              text NOT NULL,
  is_active           boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agent_rule_tenant ON agent_rule(tenant_id);

CREATE TABLE IF NOT EXISTS ai_anomaly_log (
  id           text PRIMARY KEY,
  tenant_id    text NOT NULL REFERENCES tenant(id),
  type         text NOT NULL,
  severity     text NOT NULL,
  description  text NOT NULL,
  context_json text NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ai_anomaly_tenant ON ai_anomaly_log(tenant_id);
`;
