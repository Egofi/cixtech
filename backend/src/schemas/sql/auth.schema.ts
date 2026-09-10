export const AUTH_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS principal (
  id            text PRIMARY KEY,
  -- 'operator'    — our staff, reaches the admin plane, tenant_id IS NULL
  -- 'tenant_user' — a tenant's person, reaches /v1 for THEIR tenant only
  kind          text NOT NULL CHECK (kind IN ('operator','tenant_user')),
  tenant_id     text REFERENCES tenant(id),
  email         text NOT NULL,
  -- scrypt, encoded as scrypt$N$r$p$salt$hash. Node's crypto ships it, so there
  -- is no native dependency to build, audit and keep current.
  password_hash text NOT NULL,
  role          text NOT NULL,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  -- Forces a password change on next login: set for an invited or reset account.
  must_change_password boolean NOT NULL DEFAULT false,
  failed_logins integer NOT NULL DEFAULT 0,
  locked_until  timestamptz,
  last_login_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  disabled_at   timestamptz,
  -- An operator has no tenant; a tenant user must have one. Enforced here rather
  -- than in code because a tenant_user with a NULL tenant would be a principal
  -- with access to every tenant's data.
  CONSTRAINT principal_tenant_shape CHECK (
    (kind = 'operator'    AND tenant_id IS NULL) OR
    (kind = 'tenant_user' AND tenant_id IS NOT NULL)
  )
);

-- Email is unique per plane: two tenants may each employ the same person, but
-- one tenant cannot have two accounts for one address, and neither can staff.
CREATE UNIQUE INDEX IF NOT EXISTS principal_operator_email
  ON principal (lower(email)) WHERE kind = 'operator';
CREATE UNIQUE INDEX IF NOT EXISTS principal_tenant_email
  ON principal (tenant_id, lower(email)) WHERE kind = 'tenant_user';

-- TOTP enrolment. Separate from 'principal' so a secret that has been generated
-- but never confirmed cannot be mistaken for an active second factor: a row with
-- confirmed_at IS NULL is a half-finished enrolment and grants nothing.
--
CREATE TABLE IF NOT EXISTS principal_totp (
  principal_id text PRIMARY KEY REFERENCES principal(id) ON DELETE CASCADE,
  secret       text NOT NULL,
  confirmed_at timestamptz,
  -- The last accepted time-step. A code is single-use: replaying one inside its
  -- 30-second window must not authenticate twice.
  last_step    bigint,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Single-use recovery codes, stored hashed exactly like a password.
CREATE TABLE IF NOT EXISTS principal_recovery_code (
  principal_id text NOT NULL REFERENCES principal(id) ON DELETE CASCADE,
  code_hash    text NOT NULL,
  used_at      timestamptz,
  PRIMARY KEY (principal_id, code_hash)
);

-- A live browser session.
--
-- 'token_hash' not the token: the database is the one place a stolen backup
-- could hand an attacker every live session, so it stores only what it needs to
-- verify one. Same reasoning as 'api_key.key_hash'.
--
-- 'csrf_token' backs the double-submit check. The session cookie is SameSite=None
-- (the consoles are a different origin from the API), which means the browser
-- will attach it to a cross-site request — so a header the attacker's page
-- cannot read is what actually stops CSRF.
--
-- Stored in plaintext, unlike the session token, and that is deliberate. This
-- value is not a credential: it grants nothing without the httpOnly cookie, and
-- its only job is to be unreadable by another ORIGIN. Storing it lets a reloaded
-- page recover it from GET /auth/session, which a hash cannot do.
--
-- Two expiries, deliberately. 'expires_at' is absolute and caps how long a
-- session can live at all; 'idle_expires_at' moves forward on use and closes an
-- abandoned tab. A single long expiry gives you one or the other, never both.
--
CREATE TABLE IF NOT EXISTS auth_session (
  id              text PRIMARY KEY,
  principal_id    text NOT NULL REFERENCES principal(id) ON DELETE CASCADE,
  token_hash      text NOT NULL UNIQUE,
  csrf_token      text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  idle_expires_at timestamptz NOT NULL,
  expires_at      timestamptz NOT NULL,
  revoked_at      timestamptz,
  revoked_reason  text,
  ip              text,
  user_agent      text
);
CREATE INDEX IF NOT EXISTS auth_session_principal ON auth_session (principal_id, revoked_at);
CREATE INDEX IF NOT EXISTS auth_session_expiry ON auth_session (expires_at);

-- Every authentication attempt, successful or not.
--
-- Append-only and separate from 'error_log' because this is the record you read
-- during an incident — "who tried, from where, and did it work" — and it must
-- not be crowded out by, or trimmed alongside, ordinary application errors.
--
CREATE TABLE IF NOT EXISTS auth_attempt (
  id           bigserial PRIMARY KEY,
  at           timestamptz NOT NULL DEFAULT now(),
  email        text,
  principal_id text,
  kind         text NOT NULL,
  outcome      text NOT NULL,
  ip           text,
  user_agent   text,
  detail       text
);
CREATE INDEX IF NOT EXISTS auth_attempt_at ON auth_attempt (at DESC);
CREATE INDEX IF NOT EXISTS auth_attempt_email ON auth_attempt (lower(email), at DESC);
`;
