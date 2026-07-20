# ADR 0015: Super-admin console — observe everything, control the safe plane, audit every action

**Status:** Accepted

## Context

Operating a custody engine needs a control room: a single place to see every
tenant, every deposit and payout, the ledger and its solvency, the webhook
outbox, the error trail, and the money-out guardrails — and to act during an
incident (halt payouts, replay a stuck webhook, provision a tenant).

But "an admin that can control everything" is in direct tension with the whole
security thesis of this system. ADR 0007/0014 (MPC), the policy engine (ADR
0009 / §7), and the kill-switch exist precisely so that **no single party can
move funds**. A super-admin endpoint that could sign an arbitrary transaction or
redirect a payout would be a backdoor that defeats MPC, policy, allow-listing,
and velocity limits at once — the most valuable target in the system.

## Decision

Build an admin console that is **all-seeing over the observability plane** and
**powerful but bounded over the control plane**, with a hard rule:

> The admin can observe everything and operate every control that is *safe by
> construction*, but it **cannot move value outside MPC + policy**. There is no
> "sign this" or "send funds to X" admin action. Payouts always flow through
> `PayoutService → PolicyEngine → Signer(MPC)`, which no admin credential
> overrides.

### Trust separation

- The admin plane authenticates with a **separate credential**
  (`CIXTECH_ADMIN_TOKEN`, bearer), never a tenant API key. Constant-time compare.
- Admin routes live under `/admin`; the tenant API and the admin API never share
  an auth path. `/admin/api/*` is the JSON API; `/admin` serves the console.
- v1 is a single `SUPER_ADMIN` from env. The audit `actor` field and a future
  `admin_user`/role table leave room for multiple admins and scoped roles.

### Two planes

**Observability (read-everything).** The financial and operational truth already
lives in append-only trails; the console reads across all tenants:
- **Ledger** — `journal_entry` + `posting` (the double-entry financial audit
  trail) and `balance`; solvency (Σ ASSET vs Σ LIABILITY) from `checkSolvency`.
- **Deposits / payouts** — journal entries by kind (`deposit.finalized`,
  `payout.locked/settled`, `fee.swept`, `reverse:*`).
- **Webhooks** — the `webhook_delivery` outbox (body, status, attempts, error).
- **Errors** — the ADR 0012 error-audit trail, now SQL-backed (`error_log`) so
  it is queryable, not just in-memory.
- **Tenants / accounts / keys / endpoints**.

**Control (safe, audited).** Only operations that cannot exfiltrate value:
- **Kill-switch** engage/reset — a halt only ever *stops* money movement, never
  causes it, so it is a legitimate super-admin power (durable, ADR 0009 / #17).
- **Webhook replay / cancel** — re-queue a stuck delivery or dead-letter it;
  touches only the outbox, never funds.
- **Tenant + API-key lifecycle** — provision a tenant, rotate a key.
- **Limit visibility** (per-payout cap, velocity window) — read now; tuning is a
  follow-up behind the same audit.

### Every admin action is an audit event

Each mutating admin call writes an append-only `admin_audit` row —
`actor, action, target, params (redacted), result, ip, at`. Admin actions are
the most sensitive events in the system, so they are themselves part of "see the
audit logs." Reads are not audited (volume); mutations always are, including
failed attempts.

### Console (UI)

A dependency-free single-page console served by the API itself (no external
build, no CDN — same self-contained posture as the rest of the repo), talking to
`/admin/api/*` with the bearer token. Screens: **Overview** (solvency, counts,
kill-switch), **Tenants**, **Ledger**, **Deposits**, **Payouts**, **Webhooks**
(inspect + replay/cancel), **Audit**, **Errors**.

## Consequences

- The console is genuinely all-seeing and operationally powerful, yet a
  compromised admin token **cannot steal funds** — it can halt the system, read
  everything, and manage tenants/webhooks, but value movement stays behind MPC +
  policy. The blast radius of admin compromise is denial-of-service and
  disclosure, not theft.
- Admin-action audit is the accountability backstop: every halt, replay, and
  provisioning is attributable and immutable.
- The SQL error sink (`error_log`) makes ADR 0012's trail durable and queryable.
- Follow-ups: multi-admin RBAC + per-role scopes, MFA/SSO on the admin token,
  limit tuning and allow-list management through the audited control plane,
  streaming/live tail of the outbox, and a dedicated domain event log (today the
  ledger + outbox + errors are the trails).
