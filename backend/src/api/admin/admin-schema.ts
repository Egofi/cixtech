/**
 * Admin-plane tables (ADR 0015). `admin_audit` is the append-only record of every
 * mutating admin action — the accountability backstop for the control plane.
 * `error_log` makes the ADR 0012 error-audit trail durable and queryable instead
 * of in-memory only.
 */
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
