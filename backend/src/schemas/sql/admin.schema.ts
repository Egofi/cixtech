export const ADMIN_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS admin_audit (
  id        text PRIMARY KEY,
  actor     text NOT NULL,
  action    text NOT NULL,
  target    text,
  params    text,            -- JSON, secrets redacted
  result    text NOT NULL,   -- 'ok' | 'error'
  detail    text,            -- error id/message on failure
  ip        text,
  at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS admin_audit_at ON admin_audit(at DESC);

CREATE TABLE IF NOT EXISTS error_log (
  id       text PRIMARY KEY,
  code     text NOT NULL,
  message  text NOT NULL,
  context  text,             -- JSON
  at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS error_log_at ON error_log(at DESC);
`;
