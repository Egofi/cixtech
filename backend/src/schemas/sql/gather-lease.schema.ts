export const GATHER_LEASE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS pool_gather_lease (
  key        text PRIMARY KEY,
  holder     text NOT NULL,
  acquired_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS pool_gather_lease_expiry ON pool_gather_lease(expires_at);
`;
