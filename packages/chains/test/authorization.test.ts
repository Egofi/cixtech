import { describe, expect, it } from "vitest";
import {
  AuthorizationSigner,
  InvalidAuthorizationError,
  transferCommitment,
} from "../src/payout/authorization.js";
import { AuthorizingBroadcaster } from "../src/payout/authorizing-broadcaster.js";
import type {
  BroadcastResult,
  PayoutBroadcaster,
  PayoutRequest,
} from "../src/payout/broadcaster.js";

const claims = {
  intentId: "pay-1",
  tenant: "t1",
  merchant: "m1",
  chain: "TRON",
  asset: "USDT",
  amount: "1000",
  destination: "TDest",
  sighash: "deadbeef",
  approvals: ["alice", "bob"],
};

describe("AuthorizationSigner", () => {
  const signer = new AuthorizationSigner("policy-key", "v1");

  it("mints a token that verifies under the same key", () => {
    const token = signer.mint(claims, { ttlMs: 60_000 });
    expect(signer.verify(token).intentId).toBe("pay-1");
  });

  it("rejects a token whose claims were tampered", () => {
    const token = signer.mint(claims, { ttlMs: 60_000 });
    token.claims.amount = "9999";
    expect(() => signer.verify(token)).toThrow(InvalidAuthorizationError);
  });

  it("rejects a token signed under a different policy key", () => {
    const token = signer.mint(claims, { ttlMs: 60_000 });
    expect(() => new AuthorizationSigner("other-key", "v1").verify(token)).toThrow(
      InvalidAuthorizationError,
    );
  });

  it("rejects an expired token", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const token = signer.mint(claims, { now, ttlMs: 1_000 });
    const later = new Date("2026-01-01T00:00:02Z");
    expect(() => signer.verify(token, { now: later })).toThrow(/expired/);
  });

  it("rejects a token whose sighash does not bind the transaction being signed", () => {
    const token = signer.mint(claims, { ttlMs: 60_000 });
    expect(() => signer.verify(token, { expectedSighash: "00" })).toThrow(/sighash/);
  });
});

class FakeBroadcaster implements PayoutBroadcaster {
  sent: PayoutRequest[] = [];
  async send(req: PayoutRequest): Promise<BroadcastResult> {
    this.sent.push(req);
    return { txId: `tx-${this.sent.length}` };
  }
}

describe("AuthorizingBroadcaster — the last-mile sighash gate", () => {
  const signer = new AuthorizationSigner("policy-key", "v1");
  const req = (over: Partial<PayoutRequest> = {}): PayoutRequest => ({
    chain: "TRON",
    asset: "USDT",
    amountBaseUnits: 1000n,
    fromAddress: "TPool",
    fromDerivationIndex: 0,
    toAddress: "TDest",
    ...over,
  });
  const tokenFor = (r: PayoutRequest) =>
    signer.mint(
      {
        intentId: "pay-1",
        tenant: "t1",
        merchant: "m1",
        chain: r.chain,
        asset: r.asset,
        amount: r.amountBaseUnits.toString(),
        destination: r.toAddress,
        sighash: transferCommitment({
          intentId: "pay-1",
          chain: r.chain,
          asset: r.asset,
          amount: r.amountBaseUnits.toString(),
          destination: r.toAddress,
          fromAddress: r.fromAddress,
        }),
        approvals: [],
      },
      { ttlMs: 60_000 },
    );

  it("forwards a request whose token binds the exact transfer", async () => {
    const inner = new FakeBroadcaster();
    const gate = new AuthorizingBroadcaster(inner, signer);
    const base = req();
    await gate.send({ ...base, authorization: tokenFor(base) });
    expect(inner.sent).toHaveLength(1);
  });

  it("refuses a substituted destination (token bound the original)", async () => {
    const inner = new FakeBroadcaster();
    const gate = new AuthorizingBroadcaster(inner, signer);
    const authorization = tokenFor(req());
    await expect(gate.send({ ...req({ toAddress: "TAttacker" }), authorization })).rejects.toThrow(
      /sighash/,
    );
    expect(inner.sent).toHaveLength(0);
  });

  it("refuses an unauthorized request in require mode", async () => {
    const inner = new FakeBroadcaster();
    const gate = new AuthorizingBroadcaster(inner, signer);
    await expect(gate.send(req())).rejects.toBeInstanceOf(InvalidAuthorizationError);
    expect(inner.sent).toHaveLength(0);
  });
});
