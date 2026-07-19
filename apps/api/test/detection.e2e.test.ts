import type { ChainDeposit } from "@cixtech/chains";
import { Asset, LedgerAccountKey } from "@cixtech/types";
import { describe, expect, it } from "vitest";
import type { DepositSource } from "../src/detection.js";
import { verifyWebhook } from "../src/webhooks.js";
import { auth, makeApi } from "./harness.js";

/** Records webhook deliveries for assertions. */
function recordingPoster() {
  const posts: { url: string; body: string; headers: Record<string, string> }[] = [];
  return {
    posts,
    poster: {
      async post(url: string, body: string, headers: Record<string, string>) {
        posts.push({ url, body, headers });
        return { ok: true, status: 200 };
      },
    },
  };
}

describe("deposit detection loop", () => {
  it("credits a watched address's deposit and fires a signed webhook (idempotently)", async () => {
    const webhook = recordingPoster();

    // The source returns a deposit to whichever address the pool assigned.
    let deposit: ChainDeposit | null = null;
    const source: DepositSource = {
      async fetchInbound(_chain, address) {
        return deposit && deposit.to === address ? [deposit] : [];
      },
    };

    const { app, engine, apiKey, tenant } = await makeApi({
      depositSource: source,
      webhookPoster: webhook.poster,
    });

    // Tenant configures a webhook, creates an account, gets a deposit address.
    const wh = await app.inject({
      method: "PUT",
      url: "/v1/webhook",
      headers: auth(apiKey),
      payload: { url: "https://tenant.example/hook" },
    });
    const secret = wh.json().secret as string;

    const acc = await app.inject({
      method: "POST",
      url: "/v1/accounts",
      headers: auth(apiKey),
      payload: {},
    });
    const accountId = acc.json().id as string;
    const addrRes = await app.inject({
      method: "POST",
      url: `/v1/accounts/${accountId}/deposit-addresses`,
      headers: auth(apiKey),
      payload: { chain: "TRON", asset: "USDT" },
    });
    const address = addrRes.json().address as string;

    // A confirmed deposit appears on-chain at that address.
    deposit = {
      chain: "TRON",
      txId: "abc123",
      index: 0,
      to: address,
      from: "TSender",
      asset: "USDT",
      amountBaseUnits: 10_000_000n,
    };

    // Detection polls: credits the ledger and delivers one signed webhook.
    expect(await engine.watcher.pollOnce("TRON")).toEqual({ credited: 1 });

    expect(
      await engine.ledger.availableBalance(
        LedgerAccountKey(`merchant_available:${tenant.id}:${accountId}`),
        Asset("USDT"),
      ),
    ).toBe(9_950_000n);

    expect(webhook.posts).toHaveLength(1);
    const [delivered] = webhook.posts;
    expect(delivered?.url).toBe("https://tenant.example/hook");
    const payload = JSON.parse(delivered?.body ?? "{}");
    expect(payload.event).toBe("deposit.confirmed");
    expect(payload.data).toMatchObject({ txId: "abc123", asset: "USDT", amount: "10000000" });
    // The signature verifies with the tenant's secret.
    const sig = delivered?.headers["x-cixtech-signature"] ?? "";
    expect(verifyWebhook(secret, delivered?.body ?? "", sig)).toBe(true);

    // Polling again re-sees the same tx but does not double-credit or re-deliver.
    expect(await engine.watcher.pollOnce("TRON")).toEqual({ credited: 0 });
    expect(webhook.posts).toHaveLength(1);
  });
});
