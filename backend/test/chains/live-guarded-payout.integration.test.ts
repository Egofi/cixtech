import { FetchHttpClient } from "@/chains/http.js";
import { LEDGER_SCHEMA_SQL } from "@/schemas/sql";
import { LedgerService, PayoutService } from "@/services";
import { SqlLedgerStore } from "@/stores";

import { PolicyEngine } from "@/chains/payout/policy.js";
import { TronPayoutBroadcaster } from "@/chains/payout/tron-broadcaster.js";
import { RawTronSigner } from "@/chains/tron/raw-tron-signer.js";
import { depositFinalized, splitFee } from "@/ledger";

import { Asset, IdempotencyKey, JournalEntryId, LedgerAccountKey, type SqlClient } from "@/types";
import { freshDatabase } from "@test/support/index.js";
import { describe, expect, it } from "vitest";
import { fundedGatherer } from "./pool-fixture.js";

const PK = process.env["TRON_PK"];
const RUN = process.env["CIXTECH_LIVE_GUARDED"] && PK;
const DEST = process.env["CIXTECH_PAYOUT_TO"] ?? "TTetbYe8bRMfz6ASefJACCb2gSzwbe9AqW";
const NILE_USDT = "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf";

const USDT = Asset("USDT");
const AVAILABLE = LedgerAccountKey("merchant_available:t1:m1");
const PENDING = LedgerAccountKey("merchant_pending_withdrawal:t1:m1");
const POOL = LedgerAccountKey("pool_addr:TRON:m1");

describe.skipIf(!RUN)("LIVE guarded payout (gated on CIXTECH_LIVE_GUARDED)", () => {
  it("policy → lock → real Nile broadcast → settle, in one call", async () => {
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

    const signer = new RawTronSigner(PK as string);

    const gatherer = await fundedGatherer(db, sql, {
      tenant: "t1",
      merchant: "m1",
      chain: "TRON",
      address: signer.address,
    });
    const service = new PayoutService(
      ledger,
      new PolicyEngine({ maxPerPayoutBaseUnits: 5_000_000n, allowlist: new Set([DEST]) }),
      new TronPayoutBroadcaster(new FetchHttpClient(), signer, {
        baseUrl: "https://nile.trongrid.io",
        tokenContracts: { USDT: NILE_USDT },
        feeLimitSun: 100_000_000,
      }),
      gatherer,
    );

    const res = await service.payout({
      tenant: "t1",
      merchant: "m1",
      chain: "TRON",
      asset: "USDT",
      amountBaseUnits: 1_000_000n,
      destination: DEST,
      idempotencyKey: `live-${Date.now()}`,
    });

    expect(res.txId).toMatch(/^[0-9a-f]{64}$/);
    const { net } = splitFee(10_000_000n, 50);
    expect(await ledger.availableBalance(AVAILABLE, USDT)).toBe(net - 1_000_000n);
    expect(await ledger.availableBalance(PENDING, USDT)).toBe(0n);
    expect(await ledger.getBalance(POOL, USDT)).toBe(9_000_000n);

    console.log(
      `GUARDED PAYOUT 1 USDT → ${DEST}\nTXID=${res.txId}  (https://nile.tronscan.org/#/transaction/${res.txId})`,
    );
  }, 30_000);
});
