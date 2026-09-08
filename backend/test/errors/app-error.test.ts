import { AppError, InMemoryErrorSink, captureError, toErrorRecord } from "@/errors/index.js";
import { describe, expect, it } from "vitest";

class SampleError extends AppError {
  readonly code = "SAMPLE";
}

describe("error identity & audit (ADR 0012)", () => {
  it("assigns a unique id to every AppError", () => {
    const ids = new Set(Array.from({ length: 1_000 }, () => new SampleError("x").id));
    expect(ids.size).toBe(1_000);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("carries code, context, and cause into the audit record", () => {
    const err = new SampleError("bad", { context: { requested: "10" }, cause: new Error("root") });
    const rec = err.toRecord();
    expect(rec).toMatchObject({ id: err.id, code: "SAMPLE", context: { requested: "10" } });
    expect(rec.cause).toContain("root");
    expect(rec.stack).toBeTruthy();
  });

  it("toPublic hides the message for non-exposable errors but keeps the id", () => {
    const secret = new SampleError("internal detail", { exposable: false });
    expect(secret.toPublic()).toEqual({
      id: secret.id,
      code: "SAMPLE",
      message: "An internal error occurred",
    });
  });

  it("gives even a stray non-AppError an id and marks it unexposable", () => {
    const rec = toErrorRecord("just a string");
    expect(rec.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(rec.code).toBe("UNCLASSIFIED");
    expect(rec.exposable).toBe(false);
  });

  it("captureError persists the record and returns it", async () => {
    const sink = new InMemoryErrorSink();
    const rec = await captureError(sink, new SampleError("boom"));
    expect(sink.records).toHaveLength(1);
    expect(sink.records[0]?.id).toBe(rec.id);
  });
});
