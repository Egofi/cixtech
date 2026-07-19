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
  created_at timestamptz NOT NULL DEFAULT now()
);

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
`;
