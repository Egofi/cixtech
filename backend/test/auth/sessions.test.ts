import { applySchemas } from "@/api/sql.js";
import { AuthStore, DEFAULT_SESSION_CONFIG, currentTotpStep, totpCode } from "@/auth";
import { freshDatabase } from "@test/support/index.js";
import { beforeEach, describe, expect, it } from "vitest";

/**
 * The properties a session system has to hold, each stated as the failure it
 * prevents. A long-lived API key in localStorage — what the consoles used before
 * — provides none of them.
 */
describe("human sessions", () => {
  let db: Awaited<ReturnType<typeof freshDatabase>>;
  let store: AuthStore;

  const OPERATOR = {
    kind: "operator" as const,
    email: "sam@cixtech.test",
    password: "correct horse battery staple",
    role: "viewer",
  };

  beforeEach(async () => {
    db = await freshDatabase();
    await applySchemas(db.sql);
    store = new AuthStore(db.sql);
  });

  it("authenticates a correct password and refuses a wrong one", async () => {
    await store.createPrincipal(OPERATOR);
    const ok = await store.verifyCredentials({ ...OPERATOR });
    expect(ok.outcome).toBe("ok");
    await expect(store.verifyCredentials({ ...OPERATOR, password: "wrong" })).rejects.toThrow(
      /incorrect/i,
    );
  });

  it("gives the same answer for a wrong password and an unknown account", async () => {
    await store.createPrincipal(OPERATOR);
    const unknown = await store
      .verifyCredentials({ kind: "operator", email: "nobody@cixtech.test", password: "x" })
      .catch((e: Error) => e.message);
    const wrong = await store
      .verifyCredentials({ ...OPERATOR, password: "x" })
      .catch((e: Error) => e.message);
    // Differing messages here would turn the login form into an account-
    // enumeration oracle.
    expect(unknown).toBe(wrong);
  });

  it("locks an account after repeated failures, and the lock survives a correct password", async () => {
    await store.createPrincipal(OPERATOR);
    for (let i = 0; i < DEFAULT_SESSION_CONFIG.maxFailedLogins; i++) {
      await store.verifyCredentials({ ...OPERATOR, password: "wrong" }).catch(() => {});
    }
    await expect(store.verifyCredentials({ ...OPERATOR })).rejects.toThrow(/too many/i);
  });

  it("stores only a hash of the session token", async () => {
    const p = await store.createPrincipal(OPERATOR);
    const { token } = await store.createSession(p.id);
    const { rows } = await db.sql.query<{ token_hash: string }>(
      "SELECT token_hash FROM auth_session",
    );
    expect(rows[0]?.token_hash).not.toBe(token);
    expect(rows[0]?.token_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("resolves a live session and refuses a revoked one immediately", async () => {
    const p = await store.createPrincipal(OPERATOR);
    const { token, session } = await store.createSession(p.id);
    expect((await store.resolveSession(token))?.principal.id).toBe(p.id);

    await store.revokeSession(session.id);
    // The point of server-side sessions: revocation is instant, with no waiting
    // for a token to expire and no rotating a shared credential.
    expect(await store.resolveSession(token)).toBeNull();
  });

  it("expires a session absolutely, however active it is", async () => {
    const shortLived = new AuthStore(db.sql, { ...DEFAULT_SESSION_CONFIG, absoluteMs: 1_000 });
    const p = await store.createPrincipal(OPERATOR);
    const { token } = await shortLived.createSession(p.id, {}, new Date(Date.now() - 5_000));
    expect(await shortLived.resolveSession(token)).toBeNull();
  });

  it("expires an idle session, and sliding it never exceeds the absolute cap", async () => {
    const cfg = { ...DEFAULT_SESSION_CONFIG, absoluteMs: 60_000, idleMs: 300_000 };
    const s = new AuthStore(db.sql, cfg);
    const p = await store.createPrincipal(OPERATOR);
    const { token, session } = await s.createSession(p.id);

    const resolved = await s.resolveSession(token);
    // Idle window is longer than the absolute lifetime, so it must clamp — a
    // session that slid past its absolute expiry would be unbounded.
    expect(resolved?.session.idleExpiresAt.getTime()).toBeLessThanOrEqual(
      session.expiresAt.getTime(),
    );
  });

  it("ends every session when the account is disabled", async () => {
    const p = await store.createPrincipal(OPERATOR);
    const a = await store.createSession(p.id);
    const b = await store.createSession(p.id);
    await store.setStatus(p.id, "disabled");
    expect(await store.resolveSession(a.token)).toBeNull();
    expect(await store.resolveSession(b.token)).toBeNull();
  });

  it("signs out everywhere", async () => {
    const p = await store.createPrincipal(OPERATOR);
    const a = await store.createSession(p.id);
    const b = await store.createSession(p.id);
    expect(await store.revokeAllSessions(p.id)).toBe(2);
    expect(await store.resolveSession(a.token)).toBeNull();
    expect(await store.resolveSession(b.token)).toBeNull();
  });

  it("lists a principal's live sessions with where they came from", async () => {
    const p = await store.createPrincipal(OPERATOR);
    await store.createSession(p.id, { ip: "203.0.113.7", userAgent: "Firefox" });
    await store.createSession(p.id, { ip: "198.51.100.2", userAgent: "Safari" });
    const sessions = await store.listSessions(p.id);
    expect(sessions).toHaveLength(2);
    expect(sessions.map((s) => s.ip).sort()).toEqual(["198.51.100.2", "203.0.113.7"]);
  });

  it("keeps one principal's sessions unresolvable by another's token", async () => {
    const a = await store.createPrincipal(OPERATOR);
    const b = await store.createPrincipal({ ...OPERATOR, email: "other@cixtech.test" });
    const sa = await store.createSession(a.id);
    expect((await store.resolveSession(sa.token))?.principal.id).toBe(a.id);
    expect((await store.resolveSession(sa.token))?.principal.id).not.toBe(b.id);
  });
});

describe("second factor", () => {
  let db: Awaited<ReturnType<typeof freshDatabase>>;
  let store: AuthStore;
  // `operator` requires TOTP; `viewer` does not.
  const PRIV = {
    kind: "operator" as const,
    email: "ops@cixtech.test",
    password: "a-very-long-password",
    role: "operator",
  };

  beforeEach(async () => {
    db = await freshDatabase();
    await applySchemas(db.sql);
    store = new AuthStore(db.sql);
  });

  it("demands enrolment before a privileged role gets a session", async () => {
    await store.createPrincipal(PRIV);
    const res = await store.verifyCredentials({ ...PRIV });
    // A correct password alone must not produce a session for a role that can
    // reach the kill switch.
    expect(res.outcome).toBe("mfa_enrolment_required");
  });

  it("does not demand a second factor from a viewer", async () => {
    await store.createPrincipal({ ...PRIV, email: "v@cixtech.test", role: "viewer" });
    const res = await store.verifyCredentials({
      kind: "operator",
      email: "v@cixtech.test",
      password: PRIV.password,
    });
    expect(res.outcome).toBe("ok");
  });

  it("completes enrolment only with a working code, then requires it on login", async () => {
    const p = await store.createPrincipal(PRIV);
    const secret = await store.beginTotpEnrolment(p.id);

    await expect(store.confirmTotp(p.id, "000000")).rejects.toThrow(/not correct/i);

    const codes = await store.confirmTotp(p.id, totpCode(secret, currentTotpStep()));
    expect(codes).toHaveLength(10);

    expect((await store.verifyCredentials({ ...PRIV })).outcome).toBe("mfa_required");
  });

  it("refuses a TOTP code the second time it is presented", async () => {
    const p = await store.createPrincipal(PRIV);
    const secret = await store.beginTotpEnrolment(p.id);
    await store.confirmTotp(p.id, totpCode(secret, currentTotpStep()));

    // A fresh step, so enrolment's own step does not mask the result.
    const now = new Date(Date.now() + 60_000);
    const code = totpCode(secret, currentTotpStep(now));
    expect(await store.verifySecondFactor(p.id, code, now)).toBe(true);
    // Replay inside the same 30-second window must fail, or an observed code is
    // reusable for its whole life.
    expect(await store.verifySecondFactor(p.id, code, now)).toBe(false);
  });

  it("accepts a recovery code once and never again", async () => {
    const p = await store.createPrincipal(PRIV);
    const secret = await store.beginTotpEnrolment(p.id);
    const codes = await store.confirmTotp(p.id, totpCode(secret, currentTotpStep()));
    const code = codes[0] as string;

    expect(await store.verifySecondFactor(p.id, code)).toBe(true);
    expect(await store.verifySecondFactor(p.id, code)).toBe(false);
  });

  it("issues a fresh set of recovery codes on re-enrolment, invalidating the old", async () => {
    const p = await store.createPrincipal(PRIV);
    let secret = await store.beginTotpEnrolment(p.id);
    const first = await store.confirmTotp(p.id, totpCode(secret, currentTotpStep()));

    secret = await store.beginTotpEnrolment(p.id);
    const second = await store.confirmTotp(p.id, totpCode(secret, currentTotpStep()));

    expect(new Set(first).size).toBe(10);
    expect(first.some((c) => second.includes(c))).toBe(false);
    expect(await store.verifySecondFactor(p.id, first[0] as string)).toBe(false);
  });
});
