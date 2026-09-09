import { signWebhook, verifyWebhook } from "@/chains";
import { describe, expect, it } from "vitest";

describe("webhook signing", () => {
  const body = '{"event":"deposit.confirmed","data":{"amount":"1000000"}}';

  it("signs as sha256=<hmac> and verifies", () => {
    const sig = signWebhook("shhh", body);
    expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(verifyWebhook("shhh", body, sig)).toBe(true);
  });

  it("rejects a wrong secret or tampered body", () => {
    const sig = signWebhook("shhh", body);
    expect(verifyWebhook("nope", body, sig)).toBe(false);
    expect(verifyWebhook("shhh", `${body} `, sig)).toBe(false);
    expect(verifyWebhook("shhh", body, "sha256=deadbeef")).toBe(false);
  });
});
