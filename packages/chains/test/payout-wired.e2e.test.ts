import {
  LEDGER_SCHEMA_SQL,
  LedgerService,
  SqlLedgerStore,
  depositFinalized,
  splitFee,
} from "@cixtech/ledger";
import type { SqlClient } from "@cixtech/ledger";
import type { Signer } from "@cixtech/signing";
import { freshDatabase } from "@cixtech/testing";
import { Asset, IdempotencyKey, JournalEntryId, LedgerAccountKey } from "@cixtech/types";
import { describe, expect, it } from "vitest";
import type { HttpClient } from "../src/http.js";
import { PayoutService } from "../src/payout/payout-service.js";
import { PolicyEngine } from "../src/payout/policy.js";
import { TronPayoutBroadcaster } from "../src/payout/tron-broadcaster.js";
import { abiEncodeTransfer, tronAddressToHex } from "../src/tron/tron-encoding.js";
import { fundedGatherer } from "./pool-fixture.js";
import { builtTx, trc20RawData, txIdFor } from "./tron-fixtures.js";

// Real, checksum-valid Tron addresses (the encoder validates them).
const FROM = "TJkyXySVnHjqo6VDoRNxUoCh524ViKuv5h";
const DEST = "TTetbYe8bRMfz6ASefJACCb2gSzwbe9AqW";
const NILE_USDT = "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf";

const USDT = Asset("USDT");
const AVAILABLE = LedgerAccountKey("merchant_available:t1:m1");
const PENDING = LedgerAccountKey("merchant_pending_withdrawal:t1:m1");
const POOL = LedgerAccountKey("pool_addr:TRON:m1");

/** Records POSTs and returns canned node responses — the network stand-in. */
class FakeHttp implements HttpClient {
  calls: { url: string; body: Record<string, unknown> }[] = [];
  rawDataHex = "";
  async getJson<T>(): Promise<T> {
    throw new Error("unused");
  }
  async postJson<T>(url: string, body: unknown): Promise<T> {
    this.calls.push({ url, body: body as Record<string, unknown> });
    if (url.endsWith("/triggersmartcontract")) {
      // An honest node response: the body really is the transfer that was asked
      // for, and txID really is its hash. The broadcaster checks both before it
      // will sign (see tron-tx-verify.ts).
      const b = body as { owner_address: string; contract_address: string; parameter: string };
      this.rawDataHex = trc20RawData(b.owner_address, b.contract_address, `a9059cbb${b.parameter}`);
      return { result: { result: true }, transaction: builtTx(this.rawDataHex) } as T;
    }
    if (url.endsWith("/broadcasttransaction")) return { result: true } as T;
    throw new Error(`unexpected POST ${url}`);
  }
}

// A Signer whose signature is a recognizable 65-byte pattern (0xab…).
const signer: Signer = {
  deriveAddress: () => FROM,
  signHash: () => Uint8Array.from(new Array(65).fill(0xab)),
};

async function setup() {
  const db = await freshDatabase();
  await db.exec(LEDGER_SCHEMA_SQL);
  const sql = db.sql;
  const ledger = new LedgerService(new SqlLedgerStore(sql));
  await ledger.post(
    depositFinalized({
      id: JournalEntryId("dep"),
      idempotencyKey: IdempotencyKey("dep"),
      asset: USDT,
      amount: 10_000_000n,
      feeBasisPoints: 50,
      poolAddr: POOL,
      merchantAvailable: AVAILABLE,
      feeRevenue: LedgerAccountKey("egofi_fee_revenue:t1"),
    }),
  );
  const gatherer = await fundedGatherer(db, sql, {
    tenant: "t1",
    merchant: "m1",
    chain: "TRON",
    address: FROM,
  });
  return { ledger, gatherer };
}

describe("guarded payout wired to the real Tron broadcaster (offline)", () => {
  it("gathers the source, then policy → lock → build+sign+broadcast → settle", async () => {
    const { ledger, gatherer } = await setup();
    const http = new FakeHttp();
    const broadcaster = new TronPayoutBroadcaster(http, signer, {
      baseUrl: "https://nile.trongrid.io",
      tokenContracts: { USDT: NILE_USDT },
    });
    const policy = new PolicyEngine({
      maxPerPayoutBaseUnits: 1_000_000_000n,
      allowlist: new Set([DEST]),
    });
    const service = new PayoutService(ledger, policy, broadcaster, gatherer);

    const res = await service.payout({
      tenant: "t1",
      merchant: "m1",
      chain: "TRON",
      asset: "USDT",
      amountBaseUnits: 1_000_000n,
      destination: DEST,
      idempotencyKey: "pay-1",
    });
    // The txId is now derived from the transaction body, not taken on the node's
    // word — so it is whatever hashing that body produces.
    expect(res).toEqual({ txId: txIdFor(http.rawDataHex), status: "settled", from: FROM });

    // The broadcaster built the correct TRC20 transfer and then broadcast it signed.
    const trigger = http.calls.find((c) => c.url.endsWith("/triggersmartcontract"))?.body;
    expect(trigger?.["owner_address"]).toBe(tronAddressToHex(FROM));
    expect(trigger?.["contract_address"]).toBe(tronAddressToHex(NILE_USDT));
    expect(trigger?.["parameter"]).toBe(abiEncodeTransfer(DEST, 1_000_000n));
    const broadcast = http.calls.find((c) => c.url.endsWith("/broadcasttransaction"))?.body;
    expect(broadcast?.["signature"]).toEqual(["ab".repeat(65)]);

    // The ledger moved available → pending → out of the pool, consistently.
    const { net } = splitFee(10_000_000n, 50);
    expect(await ledger.availableBalance(AVAILABLE, USDT)).toBe(net - 1_000_000n);
    expect(await ledger.availableBalance(PENDING, USDT)).toBe(0n);
    expect(await ledger.getBalance(POOL, USDT)).toBe(9_000_000n);
  });
});
