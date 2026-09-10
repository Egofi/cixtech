export const CURSOR_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS deposit_cursor (
  chain      text NOT NULL,
  address    text NOT NULL,
  next_block numeric(78,0) NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain, address)
);
`;
