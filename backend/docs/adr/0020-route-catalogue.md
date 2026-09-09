# ADR 0020: One routes folder, and access declared with the path

**Status:** accepted, implemented
**Related:** [ADR 0019](0019-central-error-handling.md) (same shape, applied to errors),
[ADR 0018](0018-session-management.md) (the roles this enforces)

## Context

Sixty-eight route registrations were spread across five files, each writing its
path as a string literal at the point of registration. Three consequences.

**A path was written in more than one place.** `/admin/api/auth-attempts` appeared
in its registration; `/admin` and `/auth` appeared again as prefixes in
`isPublic()`; `/admin/api` appeared again in the admin plane's `onRequest` hook.
Nothing tied them together.

**Access was decided inside handler bodies.** `tenantOf(req, "move-funds")` in the
tenant plane, `need(req, "admin.tenants.manage")` in the admin plane,
`mustBeSignedIn(req)` in the auth plane. To answer "what does this endpoint
require?" you read the handler. To answer "is anything unprotected?" you read all
sixty-eight.

**The auth decision was a prefix test.** This is what made it more than an
aesthetic problem — see below.

## The bug this was hiding

The admin hook read:

```ts
if (!req.url.startsWith("/admin/api")) return;
if (req.url.startsWith("/admin/api/auth")) return;
```

`"/admin/api/auth-attempts".startsWith("/admin/api/auth")` is `true`. The hook
returned before authenticating, no actor was recorded, and `need()` — written as
`if (entry?.ctx) requirePermission(...)` — did nothing when there was no entry.
`GET /admin/api/auth-attempts` served the sign-in log (emails, IPs, outcomes) to
anonymous callers. Recorded as **CX-25** in [the audit](../SECURITY_AUDIT.md).

A prefix is a guess about a set of paths. It was wrong, and nothing could tell.

## Decision

**Every path is written once in `src/common/routes/`, and every route's access is
declared beside it in a catalogue the compiler checks.**

### The routes folder

```
src/common/routes/
  system.routes.ts    SYSTEM_ROUTES   3 paths
  auth.routes.ts      AUTH_ROUTES    10
  admin.routes.ts     ADMIN_ROUTES   30
  tenant.routes.ts    TENANT_ROUTES  16
  route-access.ts     ROUTE_KEYS, ROUTE_ACCESS, accessForRoute
```

It sits under `src/common/` beside `errors/` and `exceptions/`, so the two
cross-cutting catalogues — what can go wrong, and what may be reached — live
together.

```ts
export const AUTH_ROUTES = {
  LOGIN: "/auth/login",
  LOGOUT_ALL: "/auth/logout-all",
  ...
} as const;
```

Registration reads `app.post(AUTH_ROUTES.LOGOUT_ALL, hidden, handler)`. One
constant per *path*, so `GET` and `POST /v1/accounts` share `TENANT_ROUTES.ACCOUNTS`.

### The access catalogue is total

```ts
export const ROUTE_ACCESS: Record<RouteKey, RouteAccess<Permission>> = { ... };
```

`RouteKey` is the union of `"METHOD /path"` for every route. As in ADR 0019, the
`Record` is **total**: a route with no declared access fails `tsc`. Five kinds:

| kind | meaning | count |
| --- | --- | --- |
| `public` | no credential | 5 |
| `tenant` | API key or tenant session, carrying `scope` | 21 |
| `operator` | operator session or bootstrap token, carrying `permission` | 34 |
| `session` | any signed-in principal | 7 |
| `admin-token` | the shared token only | 1 |

`admin-token` exists because `/metrics` turned out to gate itself on
`CIXTECH_ADMIN_TOKEN` directly. It had been declared `public` on the first pass;
probing every route's real behaviour is what caught it.

### Prefix tests are gone

Both hooks now resolve the route by its **matched Fastify pattern**
(`req.routeOptions.url`), which is exact — `/admin/api/auth-attempts` can never be
mistaken for a member of `/admin/api/auth`:

```ts
const access = accessForRoute(req.method, req.routeOptions?.url);
if (access?.kind !== "operator") return;
...
requirePermission(ctx, access.permission);
```

That last line replaced a blanket `requirePermission(ctx, "admin.read")` plus
**seventeen** `need(req, …)` calls scattered through the handlers. The permission
now travels with the path, and a new admin route cannot be added without one.

One prefix rule survives, named and alone: `PUBLIC_ROUTE_PREFIXES = ["/docs"]`,
because the API-reference plugin mounts a subtree rather than named routes.

## Consequences

**Better.** The access surface is one table. A new route is a compile error until
its access is declared. The permission for an admin route is impossible to forget,
because it is no longer a separate call the author must remember to write.

**Costs, honestly.**

- **Two files to add a route** — the routes module and the catalogue. Same
  friction as ADR 0019's catalogue, and the same reason.
- **`accessForRoute` depends on `req.routeOptions.url`.** Fastify sets it during
  routing, before `onRequest`. For an unmatched URL it is `undefined`, which
  resolves to no access and skips the credential hooks — correct, because the
  not-found handler answers, but it means the guarantee is "every *registered*
  route", which is exactly what the conformance test enumerates.
- **The catalogue records what the handlers do; it does not yet compute it.**
  A tenant route still calls `tenantOf(req, scope)` in its body. The declared
  scope and the asserted scope could drift. Moving scope enforcement into a hook,
  as was done for admin permissions, is the obvious next step and was left out of
  this change to keep the money-moving paths untouched.
- **Route constant names are generated from paths**, so
  `TENANTS_BY_ID_KEYS_BY_KEY_ID_REVOKE` is accurate rather than graceful.

## Verification

`test/api/route-conformance.e2e.test.ts` (7):

- No route path is registered as a bare string literal (AST scan of `src/api`).
- Every registered route is declared in the catalogue, and every declared route is
  actually served (`app.hasRoute`).
- **Every** `operator`, `tenant` and `admin-token` route, called with no
  credential, answers 401 or 403 — thirty-four, twenty-seven and one route
  respectively, rather than the single admin route the previous suite checked.
- No `public` route is refused for want of a credential.

Re-introducing the CX-25 prefix exemption fails the operator case with
`GET /admin/api/auth-attempts -> 200`.
