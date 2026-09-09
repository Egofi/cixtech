export const POOL_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS pool_address (
  id               text PRIMARY KEY,
  tenant           text NOT NULL,
  merchant         text NOT NULL,
  chain            text NOT NULL,
  derivation_index int  NOT NULL,
  address          text NOT NULL,
  state            text NOT NULL,
  invoice_id       text,
  cooldown_until   timestamptz,
  -- ADR 0011: the strategy this address was MINTED under. Load-bearing, not
  -- cosmetic — gather dispatches on this tag, never on the current toggle, so
  -- flipping the toggle can never strand an already-funded address.
  gather_strategy  text NOT NULL DEFAULT 'EOA_FUND_TRANSFER',
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (chain, address),
  UNIQUE (tenant, merchant, chain, derivation_index)
);
CREATE INDEX IF NOT EXISTS pool_address_claim ON pool_address(tenant, merchant, chain, state);

-- Upgrade path for databases created before the column existed. A schema module
-- must bring an EXISTING database up to date, not only create a new one:
-- \`CREATE TABLE IF NOT EXISTS\` is a no-op on a table that is already there, so
-- an additive change needs its own idempotent ALTER or it silently never lands.
ALTER TABLE pool_address
  ADD COLUMN IF NOT EXISTS gather_strategy text NOT NULL DEFAULT 'EOA_FUND_TRANSFER';
`;
