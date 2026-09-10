import { PolicyEngine } from "@/chains";
import { depositFinalized } from "@/ledger";
import { Asset, IdempotencyKey, JournalEntryId, LedgerAccountKey } from "@/types";
import { describe, expect, it } from "vitest";
import { DEST, auth, makeApi } from "./harness.js";

const approvalPolicy = (required: number) =>
  new PolicyEngine({
    maxPerPayoutBaseUnits: 1_000_000_000n,
    allowlist: new Set([DEST]),
    approval: { thresholdBaseUnits: 100n, required },
  });

const withdraw = (amount = "1000") => ({
  chain: "TRON",
  asset: "USDT",
  amount,
  destination: DEST,
});

async function setup(required = 1) {
  const ctx = await makeApi({ policy: approvalPolicy(required) });
  const account = await ctx.app.inject({
    method: "POST",
    url: "/v1/accounts",
    headers: auth(ctx.apiKey),
    payload: { externalRef: "m1" },
  });
  const accountId = account.json().id as string;

  await ctx.app.inject({
    method: "POST",
    url: `/v1/accounts/${accountId}/deposit-addresses`,
    headers: auth(ctx.apiKey),
    payload: { chain: "TRON", asset: "USDT" },
  });

  await ctx.engine.ledger.post(
    depositFinalized({
      id: JournalEntryId("seed"),
      idempotencyKey: IdempotencyKey("seed"),
      asset: Asset("USDT"),
      amount: 10_000_000n,
      feeBasisPoints: 0,
      poolAddr: LedgerAccountKey(`pool_addr:TRON:${accountId}`),
      merchantAvailable: LedgerAccountKey(`merchant_available:${ctx.tenant.id}:${accountId}`),
      feeRevenue: LedgerAccountKey(`egofi_fee_revenue:${ctx.tenant.id}`),
    }),
  );
  return { ...ctx, accountId };
}

const request = (ctx: Awaited<ReturnType<typeof setup>>, key: string, apiKey?: string) =>
  ctx.app.inject({
    method: "POST",
    url: `/v1/accounts/${ctx.accountId}/withdrawals`,
    headers: { ...auth(apiKey ?? ctx.apiKey), "idempotency-key": key },
    payload: withdraw(),
  });

describe("payout approvals (§7.4)", () => {
  it("returns 202 WITH the withdrawal id so the caller can route it to an approver", async () => {
    const ctx = await setup();
    const res = await request(ctx, "w1");

    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.status).toBe("PENDING_APPROVAL");
    expect(body.withdrawalId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.approvalsNeeded).toBe(1);
    expect(body.approvalsHave).toBe(0);
    expect(ctx.broadcaster.sent).toHaveLength(0);
  });

  it("settles once a DIFFERENT credential approves", async () => {
    const ctx = await setup();
    const held = (await request(ctx, "w1")).json();

    const approverKey = await ctx.engine.tenants.issueKey(ctx.tenant.id, ["approve"]);
    const res = await ctx.app.inject({
      method: "POST",
      url: `/v1/withdrawals/${held.withdrawalId}/approve`,
      headers: auth(approverKey),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("settled");
    expect(res.json().txId).toBeTruthy();
    expect(ctx.broadcaster.sent).toHaveLength(1);
  });

  it("refuses the requester approving their own payout", async () => {
    const ctx = await setup();
    const held = (await request(ctx, "w1")).json();

    const res = await ctx.app.inject({
      method: "POST",
      url: `/v1/withdrawals/${held.withdrawalId}/approve`,
      headers: auth(ctx.apiKey),
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("POLICY_SELF_APPROVAL");
    expect(ctx.broadcaster.sent).toHaveLength(0);
  });

  it("counts DISTINCT approvers — one key cannot clear a 2-of-N threshold by repeating", async () => {
    const ctx = await setup(2);
    const held = (await request(ctx, "w1")).json();
    const first = await ctx.engine.tenants.issueKey(ctx.tenant.id, ["approve"]);

    const once = await ctx.app.inject({
      method: "POST",
      url: `/v1/withdrawals/${held.withdrawalId}/approve`,
      headers: auth(first),
    });
    expect(once.statusCode).toBe(202);
    expect(once.json().approvalsHave).toBe(1);

    const twice = await ctx.app.inject({
      method: "POST",
      url: `/v1/withdrawals/${held.withdrawalId}/approve`,
      headers: auth(first),
    });
    expect(twice.statusCode).toBe(202);
    expect(twice.json().approvalsHave).toBe(1);
    expect(ctx.broadcaster.sent).toHaveLength(0);

    const second = await ctx.engine.tenants.issueKey(ctx.tenant.id, ["approve"]);
    const done = await ctx.app.inject({
      method: "POST",
      url: `/v1/withdrawals/${held.withdrawalId}/approve`,
      headers: auth(second),
    });
    expect(done.statusCode).toBe(200);
    expect(ctx.broadcaster.sent).toHaveLength(1);
  });

  it("does not broadcast twice when an approval is replayed after settlement", async () => {
    const ctx = await setup();
    const held = (await request(ctx, "w1")).json();
    const approverKey = await ctx.engine.tenants.issueKey(ctx.tenant.id, ["approve"]);
    const url = `/v1/withdrawals/${held.withdrawalId}/approve`;

    await ctx.app.inject({ method: "POST", url, headers: auth(approverKey) });
    const again = await ctx.app.inject({ method: "POST", url, headers: auth(approverKey) });

    expect(again.statusCode).toBe(200);
    expect(again.json().txId).toBeTruthy();
    expect(ctx.broadcaster.sent).toHaveLength(1);
  });

  it("404s an unknown withdrawal, and never leaks another tenant's", async () => {
    const ctx = await setup();
    const held = (await request(ctx, "w1")).json();
    const other = await ctx.engine.tenants.createTenant("other");

    const res = await ctx.app.inject({
      method: "POST",
      url: `/v1/withdrawals/${held.withdrawalId}/approve`,
      headers: auth(other.apiKey),
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("API key scopes (§16)", () => {
  it("refuses a payout from a key without move-funds", async () => {
    const ctx = await setup();
    const readOnly = await ctx.engine.tenants.issueKey(ctx.tenant.id, ["read"]);

    const res = await ctx.app.inject({
      method: "POST",
      url: `/v1/accounts/${ctx.accountId}/withdrawals`,
      headers: { ...auth(readOnly), "idempotency-key": "w-scoped" },
      payload: withdraw(),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("FORBIDDEN_SCOPE");
  });

  it("still allows reads with a read-only key", async () => {
    const ctx = await setup();
    const readOnly = await ctx.engine.tenants.issueKey(ctx.tenant.id, ["read"]);
    const res = await ctx.app.inject({
      method: "GET",
      url: "/v1/balances",
      headers: auth(readOnly),
    });
    expect(res.statusCode).toBe(200);
  });

  it("an approve-only key cannot request a payout — approve never implies move-funds", async () => {
    const ctx = await setup();
    const approveOnly = await ctx.engine.tenants.issueKey(ctx.tenant.id, ["approve"]);

    const res = await ctx.app.inject({
      method: "POST",
      url: `/v1/accounts/${ctx.accountId}/withdrawals`,
      headers: { ...auth(approveOnly), "idempotency-key": "w-approve-only" },
      payload: withdraw(),
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("FORBIDDEN_SCOPE");
  });

  it("a move-funds key cannot approve", async () => {
    const ctx = await setup();
    const held = (await request(ctx, "w1")).json();
    const mover = await ctx.engine.tenants.issueKey(ctx.tenant.id, ["move-funds"]);

    const res = await ctx.app.inject({
      method: "POST",
      url: `/v1/withdrawals/${held.withdrawalId}/approve`,
      headers: auth(mover),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("FORBIDDEN_SCOPE");
  });
});
