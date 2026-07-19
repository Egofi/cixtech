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
`;
