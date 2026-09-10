import {
  InMemoryErrorSink,
  InsufficientFundsError,
  PolicyDeniedError,
  SigningKeyUnavailableError,
  UnauthorizedError,
  handleError,
  notFoundResponse,
  resolveError,
} from "@/common";
import { describe, expect, it } from "vitest";

describe("the entrance resolves every failure the same way", () => {
  it("answers an application error with its catalogued status", () => {
    expect(resolveError(new UnauthorizedError("no key")).status).toBe(401);
    expect(resolveError(new PolicyDeniedError("denied")).status).toBe(403);
    expect(resolveError(new InsufficientFundsError("short")).status).toBe(409);
  });

  it("no longer answers an infrastructure failure with 400", () => {
    const resolved = resolveError(new SigningKeyUnavailableError("no key material"));
    expect(resolved.status).toBe(503);
    expect(resolved.body.error.message).toBe("An internal error occurred");
    expect(resolved.body.error.code).toBe("SIGNING_KEY_UNAVAILABLE");
  });

  it("keeps a correlation id on the response even when the message is withheld", () => {
    const err = new SigningKeyUnavailableError("xprv missing");
    const resolved = resolveError(err);
    expect(resolved.body.error.id).toBe(err.id);
    expect(resolved.record.message).toBe("xprv missing");
  });

  it("turns a framework validation failure into a 400", () => {
    const resolved = resolveError(
      Object.assign(new Error("body must have property 'amount'"), { validation: [{}] }),
    );
    expect(resolved.status).toBe(400);
    expect(resolved.body.error.code).toBe("VALIDATION");
    expect(resolved.body.error.message).toMatch(/amount/);
  });

  it("passes a framework 4xx through and buries a framework 5xx", () => {
    expect(resolveError(Object.assign(new Error("nope"), { statusCode: 404 })).status).toBe(404);
    const server = resolveError(Object.assign(new Error("socket detail"), { statusCode: 502 }));
    expect(server.status).toBe(500);
    expect(server.body.error.message).toBe("Internal error");
  });

  it("buries an error that is not an Error at all", () => {
    const resolved = resolveError("a thrown string");
    expect(resolved.status).toBe(500);
    expect(resolved.body.error.message).toBe("Internal error");
  });

  it("persists what is worth investigating and drops routine rejections", async () => {
    const sink = new InMemoryErrorSink();
    await handleError(new UnauthorizedError("no key"), { sink });
    expect(sink.records).toHaveLength(0);

    await handleError(new InsufficientFundsError("short"), { sink });
    await handleError(new SigningKeyUnavailableError("gone"), { sink });
    expect(sink.records.map((r) => r.code)).toEqual([
      "LEDGER_INSUFFICIENT_FUNDS",
      "SIGNING_KEY_UNAVAILABLE",
    ]);
  });

  it("raises the alarm only for a critical failure", async () => {
    const sink = new InMemoryErrorSink();
    const critical: string[] = [];
    const onCritical = (r: { code: string }) => critical.push(r.code);

    await handleError(new InsufficientFundsError("short"), { sink, onCritical });
    await handleError(new SigningKeyUnavailableError("gone"), { sink, onCritical });

    expect(critical).toEqual(["SIGNING_KEY_UNAVAILABLE"]);
  });
});

describe("an unmatched route answers in the same envelope as everything else", () => {
  it("carries a code and a correlation id like every other failure", () => {
    const resolved = notFoundResponse("POST", "/admin/tenants");
    expect(resolved.status).toBe(404);
    expect(resolved.body.error.code).toBe("NOT_FOUND");
    expect(resolved.body.error.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(resolved.body.error.message).toContain("/admin/tenants");
  });

  it("is not worth persisting", () => {
    expect(notFoundResponse("GET", "/nope").persist).toBe(false);
  });
});
