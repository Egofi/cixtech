export const POLICY_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS policy_kill_switch (
  scope      text PRIMARY KEY,
  engaged    boolean NOT NULL DEFAULT false,
  reason     text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS policy_payout_log (
  id                bigserial PRIMARY KEY,
  tenant            text NOT NULL,
  merchant          text NOT NULL,
  asset             text NOT NULL,
  amount_base_units numeric(78,0) NOT NULL,
  at                timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS policy_payout_log_window
  ON policy_payout_log(tenant, merchant, asset, at);

-- Per-(tenant, merchant, chain) destination allow-list WITH a cool-down (§7.2).
-- A freshly added address is unusable until usable_at, defeating the attacker who
-- adds their own address and drains in the same session.
CREATE TABLE IF NOT EXISTS payout_allowlist (
  tenant    text NOT NULL,
  merchant  text NOT NULL,
  chain     text NOT NULL,
  address   text NOT NULL,
  usable_at timestamptz NOT NULL,
  added_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant, merchant, chain, address)
);
`;
