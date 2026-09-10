# ADR 0018: Human sessions, separate from machine credentials

**Status:** accepted, implemented
**Supersedes:** the "v1 single admin" note in [ADR 0015](0015-admin-console.md)

## Context

Two credentials existed, and people were using the wrong one.

**API keys** (`cxk_…`) are machine credentials: long-lived, scoped, SHA-256
hashed at rest, sent on every request. That is correct for a tenant's backend
calling `/v1`.

**The admin plane** was guarded by a single static `CIXTECH_ADMIN_TOKEN` from the
environment. One shared string, no expiry, no revocation short of rotating it for
everyone, and no identity — every row in the audit trail said `super_admin`,
whoever had actually engaged the kill switch or swept the fees.

Both consoles then put their credential in `localStorage`, which the security
audit raised as CX-13. But the deeper problem was not where the credential was
stored; it was that **a long-lived machine credential was being used as a human
session**. It has no expiry, no idle timeout, no per-person revocation, and no
identity — none of which a browser session can do without.

## Decision

Add **principals** (people) and **sessions** (their browser logins) alongside API
keys, which are unchanged.

| | Machine | Human |
| --- | --- | --- |
| Credential | `cxk_…` API key | session cookie |
| Transport | `x-api-key` header | httpOnly cookie + CSRF header |
| Lifetime | until revoked | 12h absolute, 30min idle |
| Identity | key id | the person's email |
| Second factor | n/a | TOTP, required by role |

### Two kinds of principal, one table

`operator` (our staff, admin plane, no tenant) and `tenant_user` (a tenant's
person, `/v1` for their tenant only). They share `principal` because they need
identical machinery — password, TOTP, sessions, lockout — and differ only in
which plane they reach. A database `CHECK` enforces that an operator has no
tenant and a tenant user has one, because a `tenant_user` with a NULL tenant
would be a principal with access to every tenant's data.

### Roles

| Plane | Role | Can | TOTP |
| --- | --- | --- | --- |
| Admin | `owner` | everything, incl. staff accounts and the fee sweep | required |
| Admin | `operator` | kill switch, tenants, keys — not staff, not treasury | required |
| Admin | `viewer` | read the control plane | no |
| Tenant | `admin` | move funds, approve, manage their users | required |
| Tenant | `member` | move funds — **not** approve | required |
| Tenant | `viewer` | read | no |

`member` deliberately lacks `approve`: separation of duties (§7.4) is worth
nothing if the person who requests a payout can also sign it off. A tenant
session presents the scopes its role implies (`scopesForTenantRole`), so `/v1`
keeps its single authorisation check rather than growing a parallel path.

### Cookie, not bearer

The session is an httpOnly cookie, so script on the page cannot read it — an XSS
that would have exfiltrated a `localStorage` token gets nothing.

The consoles are a different origin from the API, so the cookie is `SameSite=None;
Secure`. That is exactly what SameSite exists to restrict, which makes the CSRF
check load-bearing rather than belt-and-braces: a **double-submit token**, held in
memory by the page and echoed in `x-csrf-token` on every mutation. A cross-site
attacker can make the browser *send* the cookie; the same-origin policy stops
them *reading* the token to go with it.

The CSRF value is stored in plaintext while the session token is hashed. That is
deliberate: it is not a credential — it grants nothing without the cookie, and its
only job is to be unreadable by another origin. Storing it lets a reloaded page
recover it from `GET /auth/session`, which a hash cannot.

CORS therefore runs with `credentials: true`, which raises the stakes on the
origin allowlist rather than lowering them — the spec forbids `*` with
credentials, so exact-match is enforced by the platform as well as by us.

### The shared token becomes a bootstrap, then stops

`CIXTECH_ADMIN_TOKEN` still works, but **only while no operator account exists**.
The moment the first one is created it is refused, with a message saying so. That
forces the migration instead of leaving a shared, non-expiring, unattributable
credential live beside the sessions meant to replace it.

`pnpm create-operator` talks to the database directly and always works, so this
cannot lock anyone out — including when nobody can sign in at all.

## Consequences

**Better.** Every admin action is attributable to a person. A session can be
revoked instantly, per person, without rotating a credential other integrations
share. Sessions expire twice over — absolutely, and on idle. Password guessing
stops after five attempts. Anyone who can move value carries a second factor.

**Costs, honestly.**

- **MFA challenges are in-process.** They live two minutes and are worthless
  without the password that created them, so persisting them would add a table
  whose only job is surviving a deploy mid-login. But with several API replicas
  the `/auth/mfa` call must reach the same one: use sticky sessions for that path,
  or move the map to Redis.
- **scrypt, not Argon2id.** Argon2id is the better primitive; every Node binding
  for it is a native module, and a native dependency in the image that holds the
  signing key is a real supply-chain cost. `verifyPassword` dispatches on the
  stored algorithm prefix, so both can coexist during a rehash-on-login migration
  if that changes.
- **Third-party cookie blocking.** `SameSite=None` needs the browser to accept a
  cross-site cookie. Serve the console and the API from one registrable domain
  (`console.example.com` + `api.example.com`) and set `cookie.crossSite = false`
  to get `SameSite=Lax`, which is both sufficient and stronger.
- **A password reset flow is not built.** An administrator sets a temporary
  password and the account must change it on first sign-in. Email-based self-serve
  reset needs a mail transport this engine does not have.

## Verification

`test/auth/sessions.test.ts` (17) and `test/auth/auth-http.test.ts` (19) cover the
properties as failures they prevent: identical answers for a wrong password and
an unknown account; lockout; token stored only as a hash; instant revocation;
absolute and idle expiry with the slide clamped to the cap; TOTP replay refused
inside its own window; recovery codes single-use; CSRF refused without the header;
the shared token refused once an operator exists; the audit naming the person; a
viewer refused a privileged control; a tenant session scoped to its own tenant.

The primitives are checked against the RFC 6238 test vectors before anything is
built on them.
