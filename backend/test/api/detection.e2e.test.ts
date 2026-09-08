import { type WebhookPoster, verifyWebhook } from "@/api/webhooks.js";
import type { ChainDeposit } from "@/chains";
import type { DepositSource } from "@/chains";
import { Asset, LedgerAccountKey } from "@/types";
import { describe, expect, it } from "vitest";
import { auth, makeApi } from "./harness.js";

/** Records webhook deliveries; `ok` can be toggled to simulate a down endpoint. */
function recordingPoster(ok = true) {
  const posts: { url: string; body: string; headers: Record<string, string> }[] = [];
  const state = { ok };
  const poster: WebhookPoster = {
    async post(url, body, headers) {
      posts.push({ url, body, headers });
      return { ok: state.ok, status: state.ok ? 200 : 500 };
    },
  };
  return { posts, state, poster };
}

async function configureAndAssign(app: Awaited<ReturnType<typeof makeApi>>["app"], apiKey: string) {
  const wh = await app.inject({
    method: "PUT",
    url: "/v1/webhook",
    headers: auth(apiKey),
    payload: { url: "https://tenant.example/hook" },
  });
  const acc = await app.inject({
    method: "POST",
    url: "/v1/accounts",
    headers: auth(apiKey),
    payload: {},
  });
  const accountId = acc.json().id as string;
  const addr = await app.inject({
    method: "POST",
    url: `/v1/accounts/${accountId}/deposit-addresses`,
    headers: auth(apiKey),
    payload: { chain: "TRON", asset: "USDT" },
  });
  return { secret: wh.json().secret as string, accountId, address: addr.json().address as string };
}

const depositTo = (address: string): ChainDeposit => ({
  chain: "TRON",
  txId: "abc123",
  index: 0,
  to: address,
  from: "TSender",
  asset: "USDT",
  amountBaseUnits: 10_000_000n,
});

describe("detection + webhook outbox", () => {
  it("credits, enqueues once, and the dispatcher delivers a verifiable signed webhook", async () => {
    const webhook = recordingPoster();
    let deposit: ChainDeposit | null = null;
    const source: DepositSource = {
      async fetchInbound(_chain, address) {
        return deposit && deposit.to === address ? [deposit] : [];
      },
    };
    const ctx = await makeApi({ depositSource: source, webhookPoster: webhook.poster });
    const { secret, accountId, address } = await configureAndAssign(ctx.app, ctx.apiKey);
    deposit = depositTo(address);

    // Detect: credits the ledger and ENQUEUES (no delivery yet).
    expect(await ctx.engine.watcher.pollOnce("TRON")).toEqual({ credited: 1, reversed: 0 });
    expect(webhook.posts).toHaveLength(0);
    expect(
      await ctx.engine.ledger.availableBalance(
        LedgerAccountKey(`merchant_available:${ctx.tenant.id}:${accountId}`),
        Asset("USDT"),
      ),
    ).toBe(9_950_000n);

    // Dispatch: delivers exactly one signed webhook.
    expect(await ctx.engine.webhookDispatcher.dispatchDue()).toEqual({ delivered: 1, failed: 0 });
    expect(webhook.posts).toHaveLength(1);
    const [sent] = webhook.posts;
    const payload = JSON.parse(sent?.body ?? "{}");
    expect(payload).toMatchObject({ event: "deposit.confirmed" });
    expect(payload.data).toMatchObject({ txId: "abc123", asset: "USDT", amount: "10000000" });
    expect(
      verifyWebhook(secret, sent?.body ?? "", sent?.headers["x-cixtech-signature"] ?? ""),
    ).toBe(true);

    // Re-poll: no double-credit, no new enqueue; re-dispatch: nothing due.
    expect(await ctx.engine.watcher.pollOnce("TRON")).toEqual({ credited: 0, reversed: 0 });
    expect(await ctx.engine.webhookDispatcher.dispatchDue()).toEqual({ delivered: 0, failed: 0 });
    expect(webhook.posts).toHaveLength(1);
  });

  it("retries a failing delivery with backoff, then dead-letters", async () => {
    const webhook = recordingPoster(false); // endpoint always fails
    const ctx = await makeApi({ webhookPoster: webhook.poster });
    await ctx.app.inject({
      method: "PUT",
      url: "/v1/webhook",
      headers: auth(ctx.apiKey),
      payload: { url: "https://down.example/hook" },
    });
    await ctx.engine.webhookOutbox.enqueue(ctx.tenant.id, "deposit.confirmed", { txId: "x" });

    // First attempt fails → still pending, scheduled for the future (not due now).
    const now = new Date();
    expect(await ctx.engine.webhookDispatcher.dispatchDue(now)).toEqual({
      delivered: 0,
      failed: 1,
    });
    expect(await ctx.engine.webhookDispatcher.dispatchDue(now)).toEqual({
      delivered: 0,
      failed: 0,
    }); // backed off

    // Drive attempts forward (each far in the future) until it dead-letters at 8.
    let failures = 1;
    for (let i = 0; i < 10; i++) {
      const future = new Date(now.getTime() + (i + 2) * 60 * 60_000);
      const r = await ctx.engine.webhookDispatcher.dispatchDue(future);
      failures += r.failed;
      if (r.failed === 0) break; // dead-lettered — no longer due
    }
    expect(failures).toBe(8); // MAX_ATTEMPTS
  });
});
