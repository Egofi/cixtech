export const PAYOUT_JOURNAL_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS payout_intent (
  idempotency_key   text PRIMARY KEY,
  -- Public, non-secret handle for the intent. The idempotency key is tenant-chosen
  -- and namespaced with the tenant id, so it is not something to put in a URL.
  id                text NOT NULL DEFAULT gen_random_uuid()::text,
  -- Who asked for this payout. Separation of duties (§7.4) needs it recorded at
  -- request time: an approver is only valid if they are NOT the requester, and
  -- that comparison has to survive a restart.
  requested_by      text,
  tenant            text NOT NULL,
  merchant          text NOT NULL,
  chain             text NOT NULL,
  asset             text NOT NULL,
  amount_base_units numeric(78,0) NOT NULL,
  destination       text NOT NULL,
  from_address      text,
  tx_id             text,
  status            text NOT NULL DEFAULT 'locked'
                    CHECK (status IN ('locked','broadcasting','broadcast','settled','failed')),
  last_error        text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS payout_intent_recovery ON payout_intent(status, updated_at);

-- Upgrade path for databases created before these columns existed.
ALTER TABLE payout_intent ADD COLUMN IF NOT EXISTS id text;
ALTER TABLE payout_intent ADD COLUMN IF NOT EXISTS requested_by text;
UPDATE payout_intent SET id = gen_random_uuid()::text WHERE id IS NULL;
ALTER TABLE payout_intent ALTER COLUMN id SET DEFAULT gen_random_uuid()::text;
CREATE UNIQUE INDEX IF NOT EXISTS payout_intent_id ON payout_intent(id);
`;
