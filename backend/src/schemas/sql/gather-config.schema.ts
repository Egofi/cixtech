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
