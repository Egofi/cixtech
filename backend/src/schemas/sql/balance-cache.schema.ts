export const BALANCE_CACHE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS pool_address_balance (
  chain             text NOT NULL,
  address           text NOT NULL,
  asset             text NOT NULL,
  balance_base_units numeric(78,0) NOT NULL DEFAULT 0,
  observed_at       timestamptz NOT NULL DEFAULT now(),
  source            text NOT NULL DEFAULT 'worker',
  last_error        text,
  PRIMARY KEY (chain, address, asset)
);
CREATE INDEX IF NOT EXISTS pool_address_balance_stale
  ON pool_address_balance(observed_at);
CREATE INDEX IF NOT EXISTS pool_address_balance_funded
  ON pool_address_balance(chain, asset)
  WHERE balance_base_units > 0;
`;
