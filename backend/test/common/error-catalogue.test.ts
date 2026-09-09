import { ERROR_CATALOGUE, policyFor } from "@/common";
import * as exceptions from "@/common";
import { ERROR_CODES } from "@/types";
import { describe, expect, it } from "vitest";

const isExceptionClass = (v: unknown): v is new (m: string) => { code: string } =>
  typeof v === "function" &&
  /^class/.test(Function.prototype.toString.call(v)) &&
  v.prototype instanceof Error;

const concreteExceptions = Object.entries(exceptions)
  .filter(([name, v]) => isExceptionClass(v) && !name.endsWith("Exception") && name !== "AppError")
  .map(([name, v]) => [name, v as new (m: string) => { code: string }] as const);

describe("the error catalogue is the single source of truth", () => {
  it("gives every declared code exactly one policy", () => {
    for (const code of ERROR_CODES) {
      expect(ERROR_CATALOGUE[code], `no policy for ${code}`).toBeDefined();
    }
    expect(Object.keys(ERROR_CATALOGUE).sort()).toEqual([...new Set(ERROR_CODES)].sort());
  });

  it("declares no code that no exception and no handler can raise", () => {
    const raised = new Set(concreteExceptions.map(([, C]) => new C("x").code));
    const handlerOnly = new Set([
      "VALIDATION",
      "NOT_FOUND",
      "BAD_REQUEST",
      "RATE_LIMITED",
      "INTERNAL",
      "UNCLASSIFIED",
    ]);
    for (const code of ERROR_CODES) {
      expect(raised.has(code) || handlerOnly.has(code), `${code} is declared but unreachable`).toBe(
        true,
      );
    }
  });

  it("maps every exception class to a real policy, never a silent 400 fallthrough", () => {
    expect(concreteExceptions.length).toBeGreaterThan(40);
    for (const [name, C] of concreteExceptions) {
      const code = new C("x").code;
      expect(
        ERROR_CATALOGUE[code as keyof typeof ERROR_CATALOGUE],
        `${name} -> ${code}`,
      ).toBeDefined();
    }
  });

  it("never exposes the message of a server-side fault", () => {
    for (const [code, policy] of Object.entries(ERROR_CATALOGUE)) {
      if (policy.status >= 500) {
        expect(policy.exposable, `${code} would leak an internal message`).toBe(false);
      }
    }
  });

  it("treats every 5xx as more than routine", () => {
    for (const [code, policy] of Object.entries(ERROR_CATALOGUE)) {
      if (policy.status >= 500) {
        expect(policy.severity, `${code} is a 5xx logged as routine`).not.toBe("expected");
      }
    }
  });

  it("falls back to the unclassified policy for a code it has never seen", () => {
    const policy = policyFor("NOT_A_REAL_CODE" as never);
    expect(policy.status).toBe(500);
    expect(policy.exposable).toBe(false);
  });
});
