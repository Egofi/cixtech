/** Tenant-facing API tables: tenants, their API keys (hashed), and their accounts. */
export const API_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS tenant (
  id         text PRIMARY KEY,
  name       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS api_key (
  key_hash   text PRIMARY KEY,   -- sha256 of the plaintext key; the key is shown once
  tenant_id  text NOT NULL REFERENCES tenant(id),
  -- Stable, non-secret identity for this credential (build spec §16). It is what
  -- separation of duties compares: an approval only counts if it came from a
  -- DIFFERENT key than the one that requested the payout, so the identity must be
  -- something we can record without storing the key itself.
  id         text NOT NULL DEFAULT gen_random_uuid()::text,
  label      text,
  -- Scopes: read | move-funds | approve. 'approve' deliberately does NOT imply
  -- 'move-funds' -- a credential that can rubber-stamp a payout must not also be
  -- able to request one, or dual control collapses to a single key.
  scopes     text[] NOT NULL DEFAULT ARRAY['read','move-funds','approve'],
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Upgrade path. Existing keys keep every scope so a live tenant is not locked out
-- by the migration; newly issued keys are scoped explicitly.
ALTER TABLE api_key ADD COLUMN IF NOT EXISTS id text;
ALTER TABLE api_key ADD COLUMN IF NOT EXISTS label text;
ALTER TABLE api_key ADD COLUMN IF NOT EXISTS scopes text[]
  NOT NULL DEFAULT ARRAY['read','move-funds','approve'];
UPDATE api_key SET id = gen_random_uuid()::text WHERE id IS NULL;
ALTER TABLE api_key ALTER COLUMN id SET DEFAULT gen_random_uuid()::text;
CREATE UNIQUE INDEX IF NOT EXISTS api_key_id ON api_key(id);

-- Revocation. A leaked key is only contained if it STOPS working, so rotation
-- issues a replacement and stamps the old one here; authenticate() refuses any
-- key with this set. The row is kept rather than deleted because api_key.id is
-- the identity the payout journal and approval trail already reference — a
-- revoked credential still has to be nameable in an audit years later.
ALTER TABLE api_key ADD COLUMN IF NOT EXISTS revoked_at timestamptz;
ALTER TABLE api_key ADD COLUMN IF NOT EXISTS revoked_reason text;
CREATE INDEX IF NOT EXISTS api_key_tenant_live ON api_key(tenant_id) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS account (
  id           text PRIMARY KEY,
  tenant_id    text NOT NULL REFERENCES tenant(id),
  external_ref text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS account_tenant ON account(tenant_id);

-- Reserve-then-store idempotency for mutating requests. A row is reserved
-- (response NULL) before processing; filled on success; deleted on failure so a
-- retry can proceed.
CREATE TABLE IF NOT EXISTS idempotency_key (
  tenant_id  text NOT NULL,
  key        text NOT NULL,
  status     int,
  response   text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, key)
);

-- One outbound webhook endpoint per tenant (URL + HMAC secret).
CREATE TABLE IF NOT EXISTS webhook_endpoint (
  tenant_id text PRIMARY KEY REFERENCES tenant(id),
  url       text NOT NULL,
  secret    text NOT NULL
);

-- Transactional outbox for at-least-once webhook delivery. Each row is the exact
-- signed body; the dispatcher retries with backoff and dead-letters after max
-- attempts. The body is fixed at enqueue so the HMAC signature is stable across
-- retries and receivers can dedupe on its embedded id.
CREATE TABLE IF NOT EXISTS webhook_delivery (
  id           text PRIMARY KEY,
  tenant_id    text NOT NULL,
  body         text NOT NULL,
  status       text NOT NULL DEFAULT 'pending', -- pending | delivered | dead
  attempts     int  NOT NULL DEFAULT 0,
  next_attempt timestamptz NOT NULL DEFAULT now(),
  last_error   text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS webhook_delivery_due ON webhook_delivery(status, next_attempt);
`;
