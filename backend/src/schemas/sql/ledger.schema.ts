export const LEDGER_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS journal_entry (
  id             text PRIMARY KEY,
  idempotency_key text UNIQUE NOT NULL,
  kind           text NOT NULL,
  occurred_at    timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS posting (
  id                bigserial PRIMARY KEY,
  journal_entry_id  text NOT NULL REFERENCES journal_entry(id),
  account           text NOT NULL,
  asset             text NOT NULL,
  amount            numeric NOT NULL CHECK (amount > 0),
  direction         text NOT NULL CHECK (direction IN ('DEBIT','CREDIT'))
);
CREATE INDEX IF NOT EXISTS posting_account_asset ON posting(account, asset);

CREATE TABLE IF NOT EXISTS balance (
  account  text NOT NULL,
  asset    text NOT NULL,
  amount   numeric NOT NULL DEFAULT 0,  -- signed net, DEBIT positive
  version  bigint  NOT NULL DEFAULT 0,  -- optimistic lock / update counter
  PRIMARY KEY (account, asset)
);
`;
