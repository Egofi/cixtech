import type { AddressBalance } from "@cixtech/attribution";
import { PolicyEngine } from "@cixtech/chains";
import type {
  BroadcastResult,
  ChainDeposit,
  PayoutBroadcaster,
  PayoutRequest,
} from "@cixtech/chains";
import { deriveTronAddress } from "@cixtech/chains";
import { PGlite } from "@electric-sql/pglite";
import { HDKey } from "@scure/bip32";
import type { FastifyInstance } from "fastify";
import { beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { buildEngine } from "../src/engine.js";
import { applySchemas, pgliteClient } from "../src/sql.js";

const DEST = "TTetbYe8bRMfz6ASefJACCb2gSzwbe9AqW";
const ENGINE_XPUB = HDKey.fromMasterSeed(
  Uint8Array.from(Buffer.from("00112233445566778899aabbccddeeff", "hex")),
).derive("m/44'/195'/0'").publicExtendedKey;

class FakeBroadcaster implements PayoutBroadcaster {
  sent: PayoutRequest[] = [];
  async send(req: PayoutRequest): Promise<BroadcastResult> {
    this.sent.push(req);
    return { txId: `${"a".repeat(63)}${this.sent.length}` };
  }
}
const plentiful: AddressBalance = {
  async balance() {
    return 10n ** 30n;
  },
};

async function setup() {
  const db = new PGlite();
  await applySchemas(db);
  const sql = pgliteClient(db);
  const broadcaster = new FakeBroadcaster();
  const engine = buildEngine({
    sql,
    broadcaster,
    balances: plentiful,
    policy: new PolicyEngine({ maxPerPayoutBaseUnits: 1_000_000_000n, allowlist: new Set([DEST]) }),
    engineXpub: ENGINE_XPUB,
    deriveAddress: (_chain, xpub, index) => deriveTronAddress(xpub, index),
    feeBasisPoints: 50,
  });
  const { apiKey } = await engine.tenants.createTenant("acme");
  return { app: buildApp(engine), engine, broadcaster, apiKey };
}

const auth = (apiKey: string) => ({ "x-api-key": apiKey });

async function createAccount(app: FastifyInstance, apiKey: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/v1/accounts",
    headers: auth(apiKey),
    payload: {},
  });
  return res.json().id as string;
}

describe("tenant API", () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    ctx = await setup();
  });

  it("rejects unauthenticated requests", async () => {
    const res = await ctx.app.inject({ method: "POST", url: "/v1/accounts", payload: {} });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("UNAUTHORIZED");
    expect(res.json().error.id).toMatch(/^[0-9a-f-]{36}$/); // every error carries an id (ADR 0012)
  });

  it("runs the full flow: account → deposit address → deposit credited → balance → payout", async () => {
    const { app, engine, broadcaster, apiKey } = ctx;
    const accountId = await createAccount(app, apiKey);

    // Assign a real derived deposit address.
    const addrRes = await app.inject({
      method: "POST",
      url: `/v1/accounts/${accountId}/deposit-addresses`,
      headers: auth(apiKey),
      payload: { chain: "TRON", asset: "USDT" },
    });
    expect(addrRes.statusCode).toBe(201);
    const address = addrRes.json().address as string;
    expect(address.startsWith("T")).toBe(true);

    // A confirmed deposit lands at that address (detection path).
    const deposit: ChainDeposit = {
      chain: "TRON",
      txId: "seed-tx",
      index: 0,
      to: address,
      from: "TSender",
      asset: "USDT",
      amountBaseUnits: 10_000_000n,
    };
    expect((await engine.ingestor.ingestConfirmed(deposit)).status).toBe("credited");

    // Balance reflects the deposit minus the 0.5% fee.
    const balRes = await app.inject({
      method: "GET",
      url: `/v1/accounts/${accountId}/balance?asset=USDT`,
      headers: auth(apiKey),
    });
    expect(balRes.json()).toEqual({ asset: "USDT", available: "9950000" });

    // Request a payout — guarded, gathered, signed, settled.
    const payRes = await app.inject({
      method: "POST",
      url: `/v1/accounts/${accountId}/withdrawals`,
      headers: { ...auth(apiKey), "idempotency-key": "w1" },
      payload: { chain: "TRON", asset: "USDT", amount: "1000000", destination: DEST },
    });
    expect(payRes.statusCode).toBe(200);
    expect(payRes.json().from).toBe(address); // paid from the gathered pool address
    expect(broadcaster.sent).toHaveLength(1);

    // Balance dropped by the payout.
    const balAfter = await app.inject({
      method: "GET",
      url: `/v1/accounts/${accountId}/balance?asset=USDT`,
      headers: auth(apiKey),
    });
    expect(balAfter.json().available).toBe("8950000");
  });

  it("denies a payout to a non-allow-listed destination", async () => {
    const { app, engine, apiKey } = ctx;
    const accountId = await createAccount(app, apiKey);
    const addr = await app.inject({
      method: "POST",
      url: `/v1/accounts/${accountId}/deposit-addresses`,
      headers: auth(apiKey),
      payload: { chain: "TRON", asset: "USDT" },
    });
    await engine.ingestor.ingestConfirmed({
      chain: "TRON",
      txId: "seed2",
      index: 0,
      to: addr.json().address,
      from: "TSender",
      asset: "USDT",
      amountBaseUnits: 10_000_000n,
    });

    const res = await ctx.app.inject({
      method: "POST",
      url: `/v1/accounts/${accountId}/withdrawals`,
      headers: { ...auth(apiKey), "idempotency-key": "w2" },
      payload: { chain: "TRON", asset: "USDT", amount: "1000000", destination: "TStranger" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("POLICY_DENIED");
  });

  it("replays an idempotent withdrawal (one broadcast)", async () => {
    const { app, engine, broadcaster, apiKey } = ctx;
    const accountId = await createAccount(app, apiKey);
    const addr = await app.inject({
      method: "POST",
      url: `/v1/accounts/${accountId}/deposit-addresses`,
      headers: auth(apiKey),
      payload: { chain: "TRON", asset: "USDT" },
    });
    await engine.ingestor.ingestConfirmed({
      chain: "TRON",
      txId: "seed3",
      index: 0,
      to: addr.json().address,
      from: "TSender",
      asset: "USDT",
      amountBaseUnits: 10_000_000n,
    });

    const body = { chain: "TRON", asset: "USDT", amount: "1000000", destination: DEST };
    const headers = { ...auth(apiKey), "idempotency-key": "same" };
    const first = await app.inject({
      method: "POST",
      url: `/v1/accounts/${accountId}/withdrawals`,
      headers,
      payload: body,
    });
    const second = await app.inject({
      method: "POST",
      url: `/v1/accounts/${accountId}/withdrawals`,
      headers,
      payload: body,
    });

    expect(second.json()).toEqual(first.json()); // replayed
    expect(broadcaster.sent).toHaveLength(1); // broadcast exactly once
  });
});
