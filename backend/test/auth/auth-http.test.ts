import { currentTotpStep, totpCode } from "@/auth";
import { AuthStore } from "@/stores";
import { ADMIN_TOKEN, adminAuth, makeApi } from "@test/api/harness.js";
import { describe, expect, it } from "vitest";

const cookieFrom = (setCookie: string | string[] | undefined): string => {
  const raw = Array.isArray(setCookie) ? (setCookie[0] ?? "") : (setCookie ?? "");
  return raw.split(";")[0] ?? "";
};

async function signIn(
  app: Awaited<ReturnType<typeof makeApi>>["app"],
  email: string,
  password: string,
  kind: "operator" | "tenant_user" = "operator",
) {
  const res = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { email, password, kind },
  });
  return { res, cookie: cookieFrom(res.headers["set-cookie"]), body: res.json() };
}

describe("sign-in over HTTP", () => {
  const PASSWORD = "a-sufficiently-long-password";

  it("sets an httpOnly session cookie and returns a CSRF token", async () => {
    const { app, engine } = await makeApi();
    const store = new AuthStore(engine.sql);
    await store.createPrincipal({
      kind: "operator",
      email: "viewer@cixtech.test",
      password: PASSWORD,
      role: "viewer",
    });

    const { res, body, cookie } = await signIn(app, "viewer@cixtech.test", PASSWORD);
    expect(res.statusCode).toBe(200);

    const setCookie = String(res.headers["set-cookie"]);

    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=None");
    expect(setCookie).toContain("Secure");
    expect(cookie).toMatch(/^cx_session=/);

    expect(body.csrfToken).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(body.principal.email).toBe("viewer@cixtech.test");

    expect(JSON.stringify(body)).not.toContain(cookie.split("=")[1]);
  });

  it("refuses a wrong password without setting a cookie", async () => {
    const { app, engine } = await makeApi();
    await new AuthStore(engine.sql).createPrincipal({
      kind: "operator",
      email: "v@cixtech.test",
      password: PASSWORD,
      role: "viewer",
    });
    const res = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: "v@cixtech.test", password: "nope", kind: "operator" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("returns a challenge rather than a session when the role needs a second factor", async () => {
    const { app, engine } = await makeApi();
    await new AuthStore(engine.sql).createPrincipal({
      kind: "operator",
      email: "ops@cixtech.test",
      password: PASSWORD,
      role: "operator",
    });
    const { res, body } = await signIn(app, "ops@cixtech.test", PASSWORD);
    expect(body.status).toBe("mfa_enrolment_required");
    expect(body.totp.uri).toContain("otpauth://totp/");

    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("completes MFA enrolment and issues the session plus recovery codes", async () => {
    const { app, engine } = await makeApi();
    await new AuthStore(engine.sql).createPrincipal({
      kind: "operator",
      email: "ops@cixtech.test",
      password: PASSWORD,
      role: "operator",
    });
    const { body: first } = await signIn(app, "ops@cixtech.test", PASSWORD);

    const done = await app.inject({
      method: "POST",
      url: "/auth/mfa",
      payload: {
        challenge: first.challenge,
        code: totpCode(first.totp.secret, currentTotpStep()),
        enrol: true,
      },
    });
    expect(done.statusCode).toBe(200);
    expect(done.json().recoveryCodes).toHaveLength(10);
    expect(String(done.headers["set-cookie"])).toContain("HttpOnly");
  });

  it("expires a stale MFA challenge rather than honouring it later", async () => {
    const { app, engine } = await makeApi();
    await new AuthStore(engine.sql).createPrincipal({
      kind: "operator",
      email: "ops@cixtech.test",
      password: PASSWORD,
      role: "operator",
    });
    const res = await app.inject({
      method: "POST",
      url: "/auth/mfa",
      payload: { challenge: "chal_nonexistent", code: "123456" },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("CSRF", () => {
  const PASSWORD = "a-sufficiently-long-password";

  async function viewerSession() {
    const ctx = await makeApi();
    await new AuthStore(ctx.engine.sql).createPrincipal({
      kind: "operator",
      email: "v@cixtech.test",
      password: PASSWORD,
      role: "owner",
    });

    const { body: first } = await signIn(ctx.app, "v@cixtech.test", PASSWORD);
    const done = await ctx.app.inject({
      method: "POST",
      url: "/auth/mfa",
      payload: {
        challenge: first.challenge,
        code: totpCode(first.totp.secret, currentTotpStep()),
        enrol: true,
      },
    });
    return { ...ctx, cookie: cookieFrom(done.headers["set-cookie"]), csrf: done.json().csrfToken };
  }

  it("allows a GET with the cookie alone", async () => {
    const { app, cookie } = await viewerSession();
    const res = await app.inject({ method: "GET", url: "/auth/session", headers: { cookie } });
    expect(res.statusCode).toBe(200);
  });

  it("REFUSES a mutation carrying the cookie but no CSRF header", async () => {
    const { app, cookie } = await viewerSession();

    const res = await app.inject({ method: "POST", url: "/auth/logout-all", headers: { cookie } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("CSRF_FAILED");
  });

  it("REFUSES a mutation with a wrong CSRF token", async () => {
    const { app, cookie } = await viewerSession();
    const res = await app.inject({
      method: "POST",
      url: "/auth/logout-all",
      headers: { cookie, "x-csrf-token": "not-the-right-value" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("allows the mutation with the matching CSRF token", async () => {
    const { app, cookie, csrf } = await viewerSession();
    const res = await app.inject({
      method: "POST",
      url: "/auth/logout-all",
      headers: { cookie, "x-csrf-token": csrf },
    });
    expect(res.statusCode).toBe(200);
  });

  it("ends the session on sign-out, so the cookie stops working", async () => {
    const { app, cookie, csrf } = await viewerSession();
    await app.inject({
      method: "POST",
      url: "/auth/logout",
      headers: { cookie, "x-csrf-token": csrf },
    });
    const after = await app.inject({ method: "GET", url: "/auth/session", headers: { cookie } });
    expect(after.statusCode).toBe(401);
  });
});

describe("the admin plane migrates off the shared token", () => {
  const PASSWORD = "a-sufficiently-long-password";

  it("accepts the shared token while no operator exists", async () => {
    const { app } = await makeApi();
    const res = await app.inject({
      method: "GET",
      url: "/admin/api/overview",
      headers: adminAuth(ADMIN_TOKEN),
    });
    expect(res.statusCode).toBe(200);
  });

  it("REFUSES the shared token once an operator account exists", async () => {
    const { app, engine } = await makeApi();
    await new AuthStore(engine.sql).createPrincipal({
      kind: "operator",
      email: "first@cixtech.test",
      password: PASSWORD,
      role: "owner",
    });
    const res = await app.inject({
      method: "GET",
      url: "/admin/api/overview",
      headers: adminAuth(ADMIN_TOKEN),
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().error.message).toMatch(/operator accounts exist/i);
  });

  it("records the person in the audit trail, not 'super_admin'", async () => {
    const { app, engine } = await makeApi();
    const store = new AuthStore(engine.sql);
    await store.createPrincipal({
      kind: "operator",
      email: "sam@cixtech.test",
      password: PASSWORD,
      role: "owner",
    });
    const { body: first } = await signIn(app, "sam@cixtech.test", PASSWORD);
    const done = await app.inject({
      method: "POST",
      url: "/auth/mfa",
      payload: {
        challenge: first.challenge,
        code: totpCode(first.totp.secret, currentTotpStep()),
        enrol: true,
      },
    });
    const cookie = cookieFrom(done.headers["set-cookie"]);
    const csrf = done.json().csrfToken;

    await app.inject({
      method: "POST",
      url: "/admin/api/killswitch/engage",
      headers: { cookie, "x-csrf-token": csrf },
      payload: { reason: "drill" },
    });

    const { rows } = await engine.sql.query<{ actor: string; action: string }>(
      "SELECT actor, action FROM admin_audit ORDER BY at DESC LIMIT 1",
    );
    expect(rows[0]?.action).toBe("killswitch.engage");
    expect(rows[0]?.actor).toBe("sam@cixtech.test");
  });

  it("stops a viewer from reaching a privileged control", async () => {
    const { app, engine } = await makeApi();
    await new AuthStore(engine.sql).createPrincipal({
      kind: "operator",
      email: "read@cixtech.test",
      password: PASSWORD,
      role: "viewer",
    });
    const { cookie, body } = await signIn(app, "read@cixtech.test", PASSWORD);

    const read = await app.inject({
      method: "GET",
      url: "/admin/api/overview",
      headers: { cookie },
    });
    expect(read.statusCode).toBe(200);

    const halt = await app.inject({
      method: "POST",
      url: "/admin/api/killswitch/engage",
      headers: { cookie, "x-csrf-token": body.csrfToken },
      payload: { reason: "nope" },
    });
    expect(halt.statusCode).toBe(403);
    expect(halt.json().error.code).toBe("FORBIDDEN");
  });

  it("refuses a tenant user's session on the admin plane", async () => {
    const { app, engine, tenant } = await makeApi();
    await new AuthStore(engine.sql).createPrincipal({
      kind: "tenant_user",
      tenantId: tenant.id,
      email: "person@acme.test",
      password: PASSWORD,
      role: "viewer",
    });
    const { cookie } = await signIn(app, "person@acme.test", PASSWORD, "tenant_user");
    const res = await app.inject({
      method: "GET",
      url: "/admin/api/overview",
      headers: { cookie },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("tenant users reach /v1 with their role's scopes", () => {
  const PASSWORD = "a-sufficiently-long-password";

  async function tenantSession(role: string) {
    const ctx = await makeApi();
    await new AuthStore(ctx.engine.sql).createPrincipal({
      kind: "tenant_user",
      tenantId: ctx.tenant.id,
      email: `${role}@acme.test`,
      password: PASSWORD,
      role,
    });
    const first = await signIn(ctx.app, `${role}@acme.test`, PASSWORD, "tenant_user");
    if (first.body.status !== "mfa_enrolment_required") {
      return { ...ctx, cookie: first.cookie, csrf: first.body.csrfToken };
    }
    const done = await ctx.app.inject({
      method: "POST",
      url: "/auth/mfa",
      payload: {
        challenge: first.body.challenge,
        code: totpCode(first.body.totp.secret, currentTotpStep()),
        enrol: true,
      },
    });
    return { ...ctx, cookie: cookieFrom(done.headers["set-cookie"]), csrf: done.json().csrfToken };
  }

  it("lets a viewer read but not move funds", async () => {
    const { app, cookie, csrf } = await tenantSession("viewer");
    expect(
      (await app.inject({ method: "GET", url: "/v1/balances", headers: { cookie } })).statusCode,
    ).toBe(200);

    const create = await app.inject({
      method: "POST",
      url: "/v1/accounts",
      headers: { cookie, "x-csrf-token": csrf },
      payload: {},
    });
    expect(create.statusCode).toBe(403);
  });

  it("scopes a session to its OWN tenant's data", async () => {
    const { app, engine, cookie, tenant } = await tenantSession("viewer");
    const other = await engine.tenants.createTenant("other-co");
    await engine.tenants.createAccount(other.tenant.id, "not-yours");

    const res = await app.inject({ method: "GET", url: "/v1/accounts", headers: { cookie } });
    const ids: string[] = res.json().accounts.map((a: { id: string }) => a.id);
    const mine = await engine.tenants.listAccounts(tenant.id);
    expect(ids.sort()).toEqual(mine.map((a) => a.id).sort());
  });

  it("does not let a member approve their own payout — separation of duties in roles", async () => {
    const { app, cookie, csrf } = await tenantSession("member");

    const res = await app.inject({
      method: "POST",
      url: "/v1/withdrawals/some-id/approve",
      headers: { cookie, "x-csrf-token": csrf },
    });
    expect(res.statusCode).toBe(403);
  });

  it("still accepts an API key — machines are unaffected", async () => {
    const { app, apiKey } = await makeApi();
    const res = await app.inject({
      method: "GET",
      url: "/v1/balances",
      headers: { "x-api-key": apiKey },
    });
    expect(res.statusCode).toBe(200);
  });
});
