import type { HttpClient } from "@/chains/http.js";
import { LEDGER_SCHEMA_SQL } from "@/schemas/sql";
import { LedgerService, PayoutService } from "@/services";
import { SqlLedgerStore } from "@/stores";

import { PolicyEngine } from "@/chains/payout/policy.js";
import { TronPayoutBroadcaster } from "@/chains/payout/tron-broadcaster.js";
import { abiEncodeTransfer, tronAddressToHex } from "@/chains/tron/tron-encoding.js";
import { depositFinalized, splitFee } from "@/ledger";

import type { Signer } from "@/signing";
import { Asset, IdempotencyKey, JournalEntryId, LedgerAccountKey, type SqlClient } from "@/types";
import { freshDatabase } from "@test/support/index.js";
import { describe, expect, it } from "vitest";
import { fundedGatherer } from "./pool-fixture.js";
import { builtTx, trc20RawData, txIdFor } from "./tron-fixtures.js";

const FROM = "TJkyXySVnHjqo6VDoRNxUoCh524ViKuv5h";
const DEST = "TTetbYe8bRMfz6ASefJACCb2gSzwbe9AqW";
const NILE_USDT = "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf";

const USDT = Asset("USDT");
const AVAILABLE = LedgerAccountKey("merchant_available:t1:m1");
const PENDING = LedgerAccountKey("merchant_pending_withdrawal:t1:m1");
const POOL = LedgerAccountKey("pool_addr:TRON:m1");

class FakeHttp implements HttpClient {
  calls: { url: string; body: Record<string, unknown> }[] = [];
  rawDataHex = "";
  async getJson<T>(): Promise<T> {
    throw new Error("unused");
  }
  async postJson<T>(url: string, body: unknown): Promise<T> {
    this.calls.push({ url, body: body as Record<string, unknown> });
    if (url.endsWith("/triggersmartcontract")) {
      const b = body as { owner_address: string; contract_address: string; parameter: string };
      this.rawDataHex = trc20RawData(b.owner_address, b.contract_address, `a9059cbb${b.parameter}`);
      return { result: { result: true }, transaction: builtTx(this.rawDataHex) } as T;
    }
    if (url.endsWith("/broadcasttransaction")) return { result: true } as T;
    throw new Error(`unexpected POST ${url}`);
  }
}

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

    expect(res).toEqual({ txId: txIdFor(http.rawDataHex), status: "settled", from: FROM });

    const trigger = http.calls.find((c) => c.url.endsWith("/triggersmartcontract"))?.body;
    expect(trigger?.["owner_address"]).toBe(tronAddressToHex(FROM));
    expect(trigger?.["contract_address"]).toBe(tronAddressToHex(NILE_USDT));
    expect(trigger?.["parameter"]).toBe(abiEncodeTransfer(DEST, 1_000_000n));
    const broadcast = http.calls.find((c) => c.url.endsWith("/broadcasttransaction"))?.body;
    expect(broadcast?.["signature"]).toEqual(["ab".repeat(65)]);

    const { net } = splitFee(10_000_000n, 50);
    expect(await ledger.availableBalance(AVAILABLE, USDT)).toBe(net - 1_000_000n);
    expect(await ledger.availableBalance(PENDING, USDT)).toBe(0n);
    expect(await ledger.getBalance(POOL, USDT)).toBe(9_000_000n);
  });
});
