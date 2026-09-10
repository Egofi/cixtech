export const PAYOUT_APPROVAL_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS payout_approval (
  intent_key text NOT NULL,
  approver   text NOT NULL,
  tenant     text NOT NULL,
  at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (intent_key, approver)
);
CREATE INDEX IF NOT EXISTS payout_approval_tenant ON payout_approval(tenant, intent_key);
`;
